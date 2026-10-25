// Pure helpers shared by R2StorageProvider (writes) and src/lib/object-stream.ts
// (reads). Kept free of network code so route tests can mock the R2 layer
// while still using the real error guards.

/**
 * Value written to StoredTrack.storageType for files in the R2 bucket. Rows
 * with any other value (the suspended Vercel Blob store's "blob", older
 * "s3" / "local") are stale: routes drop them and re-stream the track live.
 */
export const STORAGE_TYPE = "r2";

/**
 * Map a storagePath (as saved in StoredTrack, e.g. "music/Artist/Album/Track.mp3")
 * to an object key. Keys have no notion of absolute paths, so leading slashes
 * are dropped, Windows separators normalized and repeated slashes collapsed
 * (generatePath produces "//" from downloadLocation "music/").
 */
export function toObjectKey(storagePath: string): string {
	return storagePath.replace(/\\/g, "/").replace(/\/{2,}/g, "/").replace(/^\//, "");
}

/** Prefix of every object written by progressive persists (C9). */
export const TRACKS_PREFIX = "tracks/";

/** Prefix of the rendered Lyrics Stories: `stories/{userId}/{renderId}.mp4`, deleted 24 h after ready. */
export const STORIES_PREFIX = "stories/";

const EXTENSIONS: Record<number, string> = {
	9: ".flac", // FLAC
	3: ".mp3", // MP3_320
	1: ".mp3", // MP3_128
	8: ".mp3", // MP3_MISC
	0: ".mp3", // LOCAL
	13: ".mp4", // MP4_RA1
	14: ".mp4", // MP4_RA2
	15: ".mp4", // MP4_RA3
};

/** File extension of a TrackFormats value. */
export function trackExtension(bitrate: number): string {
	return EXTENSIONS[bitrate] ?? ".mp3";
}

/**
 * Object key of a cached track (C9): "tracks/{trackId}/{bitrate}{ext}".
 * Known before any metadata is fetched and unique per StoredTrack row — the
 * old template path ("music/{artist} - {title}.mp3") was shared by every
 * version of a song and by MP3 128 vs 320, so copies overwrote each other.
 */
export function trackObjectKey(trackId: string | number, bitrate: number): string {
	const id = String(trackId);
	if (!/^\d+$/.test(id)) throw new Error(`invalid track id for an object key: "${id}"`);
	return `${TRACKS_PREFIX}${id}/${bitrate}${trackExtension(bitrate)}`;
}

export function inferContentType(path: string): string {
	// Lyrics Stories (src/lib/story/story-render.ts) are videos; every other .mp4 is a Deezer MP4 track.
	if (toObjectKey(path).startsWith(STORIES_PREFIX)) return "video/mp4";
	const ext = path.split(".").pop()?.toLowerCase();
	switch (ext) {
		case "flac":
			return "audio/flac";
		case "mp4":
			return "audio/mp4";
		case "jpg":
		case "jpeg":
			return "image/jpeg";
		case "png":
			return "image/png";
		default:
			return "audio/mpeg";
	}
}

/** The object does not exist (deleted, never uploaded, stale DB row). */
export class StorageNotFoundError extends Error {
	readonly name = "NotFound";
	constructor(key: string) {
		super(`Object not found: ${key}`);
	}
}

/** Storage is unreachable or refusing right now — the file may still exist. */
export class StorageUnavailableError extends Error {
	readonly name = "StorageUnavailable";
	constructor(cause: unknown) {
		super("Object storage unavailable", { cause });
	}
}

export function isStorageNotFound(e: unknown): boolean {
	return e instanceof StorageNotFoundError;
}

export function isStorageUnavailable(e: unknown): boolean {
	return e instanceof StorageUnavailableError;
}
