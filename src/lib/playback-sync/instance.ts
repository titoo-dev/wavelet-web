import type { PlaybackSync } from "./sync";

/** The running sync of this tab (one per signed-in tab), for the device picker. */
let current: PlaybackSync | null = null;

export function setPlaybackSync(sync: PlaybackSync | null) {
	current = sync;
}

export function getPlaybackSync(): PlaybackSync | null {
	return current;
}
