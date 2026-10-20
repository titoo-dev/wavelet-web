import type { PlayerTrack } from "@/stores/usePlayerStore";
import type { PlaybackState, Queue, Track } from "./types";

/** Most tracks a published queue window holds (convex/validators.ts MAX_QUEUE). */
export const MAX_QUEUE = 1000;
/** Played tracks kept before the current one when the queue is longer than a window. */
const WINDOW_BEHIND = 100;

/**
 * The fields Convex stores. Track objects in the app may carry more (they are often spread from
 * API payloads) and Convex refuses unknown fields (was: "extra field" errors on publish).
 */
export function toSessionTrack(t: PlayerTrack): Track {
	return {
		trackId: String(t.trackId),
		title: t.title ?? "",
		artist: t.artist ?? "",
		artistId: t.artistId ?? null,
		album: t.album ?? null,
		albumId: t.albumId ?? null,
		cover: t.cover ?? null,
		duration: typeof t.duration === "number" && isFinite(t.duration) ? t.duration : null,
	};
}

export function toPlayerTrack(t: Track): PlayerTrack {
	return {
		trackId: t.trackId,
		title: t.title,
		artist: t.artist,
		artistId: t.artistId ?? null,
		album: t.album ?? null,
		albumId: t.albumId ?? null,
		cover: t.cover ?? null,
		duration: t.duration ?? null,
	};
}

/** Where the published window of a queue of `length` starts, keeping `index` inside it. */
export function windowStartFor(length: number, index: number): number {
	if (length <= MAX_QUEUE) return 0;
	return Math.max(0, Math.min(Math.max(0, index) - WINDOW_BEHIND, length - MAX_QUEUE));
}

export interface LocalPlayback {
	currentTrack: PlayerTrack | null;
	queue: PlayerTrack[];
	queueIndex: number;
	isPlaying: boolean;
	currentTime: number;
	shuffle: boolean;
	repeat: "off" | "all" | "one";
}

/** The local player as a Playback Session: state (window indexes) and its queue window. */
export function toSession(p: LocalPlayback): { state: PlaybackState; queue: Queue } {
	const windowStart = windowStartFor(p.queue.length, p.queueIndex);
	const tracks = p.queue.slice(windowStart, windowStart + MAX_QUEUE).map(toSessionTrack);
	return {
		state: {
			index: p.currentTrack && p.queueIndex >= 0 ? p.queueIndex - windowStart : -1,
			currentTrack: p.currentTrack ? toSessionTrack(p.currentTrack) : null,
			isPlaying: !!p.currentTrack && p.isPlaying,
			positionMs: Math.max(0, Math.round((p.currentTime || 0) * 1000)),
			shuffle: p.shuffle,
			repeat: p.repeat,
		},
		queue: { tracks, windowStart },
	};
}

/** Where the session's position is at `now`, given the local time it was true (`anchor`), in seconds. */
export function extrapolate(state: PlaybackState, anchor: number, now: number): number {
	const ms = state.isPlaying ? state.positionMs + Math.max(0, now - anchor) : state.positionMs;
	const duration = state.currentTrack?.duration;
	const capped = duration ? Math.min(ms, duration * 1000) : ms;
	return capped / 1000;
}

/**
 * Where the server's clock stands against this tab's, so a position stamped on the server is
 * extrapolated from when it was true rather than from when it arrived: a snapshot met on reconnect
 * can be up to a position refresh old.
 *
 * Every server time seen on arrival gives `local − server` = clock offset + how late it came; the
 * smallest of the recent ones is the estimate (a stale snapshot only reads larger). The snapshot
 * itself is one of them, so a position is never placed after its arrival.
 */
export class ServerClock {
	private static readonly KEPT = 8;
	private readonly lags: number[] = [];

	observe(serverMs: number, receivedAt: number) {
		this.lags.push(receivedAt - serverMs);
		if (this.lags.length > ServerClock.KEPT) this.lags.shift();
	}

	/** This tab's time when the server's clock read `serverMs`. */
	toLocal(serverMs: number): number {
		return serverMs + (this.lags.length ? Math.min(...this.lags) : 0);
	}
}
