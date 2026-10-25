// The audio a Story Render cuts its excerpt from: the start of the track up to a little past the
// excerpt's end, written to /tmp. It comes from the cached R2 copy when there is one, else it is
// decrypted live from Deezer with the listener's own session (docs/lyrics-stories.md § Règles).
// Reading from byte 0 keeps ffmpeg's `-ss` exact whatever the format (ID3 tags, FLAC, VBR).
import { createWriteStream } from "fs";
import { rm } from "fs/promises";
import { Readable } from "stream";
import type { ReadableStream as WebReadableStream } from "stream/web";
import { TrackFormats } from "@/lib/deezer/types";

/** Read this far past the excerpt's end, so a slightly uneven bitrate never cuts it short. */
export const TAIL_MARGIN_MS = 3_000;
const SLACK_BYTES = 64 * 1024;

/** How many bytes of a `totalBytes` file of `trackMs` hold everything up to `endMs` (plus margins). */
export function prefixBytes(totalBytes: number, trackMs: number, endMs: number): number {
	if (!(totalBytes > 0) || !(trackMs > 0)) return totalBytes;
	return Math.min(totalBytes, Math.ceil((totalBytes * (endMs + TAIL_MARGIN_MS)) / trackMs) + SLACK_BYTES);
}

/** No audio for this track: no cached copy and Deezer refused or failed. `code` goes to the client. */
export class AudioUnavailableError extends Error {
	readonly name = "AudioUnavailableError";
	constructor(
		readonly code: "NO_DEEZER" | "AUDIO_UNAVAILABLE",
		message: string
	) {
		super(message);
	}
}

export interface CachedCopy {
	storagePath: string;
	fileSize: number | null;
}

export interface DecryptedAudio {
	readable: Readable;
	/** Decoded size of the whole track; null when unknown. */
	totalLength: number | null;
	abort(): void;
}

export interface AudioSourceDeps {
	findCopy(userId: string, trackId: string): Promise<CachedCopy | null>;
	/** The object's bytes [0, end], or null when it cannot be read. */
	readObject(storagePath: string, end: number | null): Promise<WebReadableStream<Uint8Array> | null>;
	/** The whole decrypted track, through the user's Deezer session. Throws AudioUnavailableError. */
	openDeezer(userId: string, trackId: string): Promise<DecryptedAudio>;
}

export interface ExcerptAudio {
	file: string;
	origin: "cache" | "deezer";
	cleanup(): Promise<void>;
}

/** Copies at most `limit` bytes of `readable` to `file`, then stops reading. */
async function writePrefix(readable: AsyncIterable<Uint8Array>, file: string, limit: number | null, stop: () => void) {
	const out = createWriteStream(file);
	let written = 0;
	try {
		for await (const chunk of readable) {
			const room = limit == null ? chunk.length : limit - written;
			const part = room < chunk.length ? chunk.subarray(0, room) : chunk;
			if (!out.write(part)) await new Promise<void>((r) => out.once("drain", () => r()));
			written += part.length;
			if (limit != null && written >= limit) {
				stop();
				break;
			}
		}
	} finally {
		await new Promise<void>((resolve, reject) => out.end((e?: Error | null) => (e ? reject(e) : resolve())));
	}
	return written;
}

/**
 * Writes the audio of `trackId` up to past `endMs` to `file`: the cached copy first (a read
 * failure falls through to Deezer), then the live decrypted stream.
 */
export async function fetchExcerptAudio(
	opts: { userId: string; trackId: string; endMs: number; trackDurationMs: number; file: string },
	deps: AudioSourceDeps
): Promise<ExcerptAudio> {
	const { userId, trackId, endMs, trackDurationMs, file } = opts;
	const cleanup = () => rm(file, { force: true });

	const copy = await deps.findCopy(userId, trackId).catch(() => null);
	if (copy) {
		try {
			const limit = copy.fileSize ? prefixBytes(copy.fileSize, trackDurationMs, endMs) : null;
			const body = await deps.readObject(copy.storagePath, limit == null ? null : limit - 1);
			if (body) {
				const written = await writePrefix(Readable.fromWeb(body), file, null, () => {});
				if (written > 0) return { file, origin: "cache", cleanup };
			}
		} catch {
			// Storage down or the object gone: Deezer below.
		}
		await cleanup();
	}

	const audio = await deps.openDeezer(userId, trackId);
	try {
		const limit = audio.totalLength ? prefixBytes(audio.totalLength, trackDurationMs, endMs) : null;
		const written = await writePrefix(audio.readable, file, limit, () => audio.abort());
		if (written === 0) throw new AudioUnavailableError("AUDIO_UNAVAILABLE", "Deezer sent no audio.");
	} catch (e) {
		audio.abort();
		await cleanup();
		if (e instanceof AudioUnavailableError) throw e;
		throw new AudioUnavailableError("AUDIO_UNAVAILABLE", `Deezer stream failed: ${e instanceof Error ? e.message : String(e)}`);
	}
	return { file, origin: "deezer", cleanup };
}

/** The production seams: StoredTrack + R2, and the user's Deezer session. */
export const defaultAudioSourceDeps: AudioSourceDeps = {
	async findCopy(userId, trackId) {
		const { findCachedCopy, resolveCacheQuery } = await import("@/lib/wavelet/storage/cached-copy");
		const decision = await findCachedCopy(trackId, await resolveCacheQuery(userId));
		// An under-quality copy is still a fine source for a 60 s excerpt.
		const row = decision.kind === "hit" ? decision.row : decision.kind === "upgrade" ? decision.best : null;
		// findCachedCopy loads whole StoredTrack rows; its type only names the fields it reads.
		return row ? { storagePath: row.storagePath, fileSize: (row as { fileSize?: number | null }).fileSize ?? null } : null;
	},
	async readObject(storagePath, end) {
		const { streamObject } = await import("@/lib/object-stream");
		const res = await streamObject(storagePath, end == null ? undefined : `bytes=0-${end}`);
		return (res.body as WebReadableStream<Uint8Array> | null) ?? null;
	},
	async openDeezer(userId, trackId) {
		const { restoreUserDz } = await import("@/lib/deezer-session");
		const restored = await restoreUserDz(userId);
		if (restored.status !== "ok") {
			throw new AudioUnavailableError("NO_DEEZER", "No Deezer session to stream this track.");
		}
		const { getWaveletApp } = await import("@/lib/server-state");
		const { resolveStreamTrack } = await import("@/lib/wavelet/progressive-stream");
		const { openDecryptedStream } = await import("@/lib/wavelet/decryption");
		const app = await getWaveletApp();
		if (!app) throw new AudioUnavailableError("AUDIO_UNAVAILABLE", "The streaming engine is unavailable.");
		try {
			const settings = await app.freshSettings();
			const { track } = await resolveStreamTrack(restored.dz, trackId, TrackFormats.MP3_320, settings);
			const stream = await openDecryptedStream(track);
			return { readable: stream.readable, totalLength: stream.totalLength, abort: () => stream.abort() };
		} catch (e) {
			throw new AudioUnavailableError("AUDIO_UNAVAILABLE", `Deezer refused the track: ${e instanceof Error ? e.message : String(e)}`);
		}
	},
};
