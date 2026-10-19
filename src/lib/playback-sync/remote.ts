import type { Command } from "./types";

/**
 * While this Device is a Remote, the player store hands its transport and queue actions to the
 * sync as Commands instead of changing anything itself (ADR 0003). Null otherwise.
 */
type Sender = (command: Command) => void;

let sender: Sender | null = null;

export function setRemoteSender(next: Sender | null) {
	sender = next;
}

export function isRemote(): boolean {
	return sender !== null;
}

/** Sends `command` when this Device is a Remote; false means "carry out the action locally". */
export function sendIfRemote(command: Command | (() => Command)): boolean {
	if (!sender) return false;
	sender(typeof command === "function" ? command() : command);
	return true;
}

/** The Active Device's volume (0..1) as last heartbeated, for a Remote's mute toggle. */
let remoteVolume: number | null = null;
let lastNonZeroRemoteVolume = 0.8;

export function setRemoteVolume(volume: number | null) {
	remoteVolume = volume;
	if (volume !== null && volume > 0) lastNonZeroRemoteVolume = volume;
}

export function getRemoteVolume(): number | null {
	return remoteVolume;
}

/** The Command a Remote's mute toggle sends: mute, or back to the last non-zero volume. */
export function muteToggleCommand(): Command {
	return { type: "setVolume", volume: remoteVolume !== null && remoteVolume > 0 ? 0 : lastNonZeroRemoteVolume };
}
