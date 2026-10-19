import { usePlayerStore } from "@/stores/usePlayerStore";
import { toPlayerTrack } from "./track";
import type { Command } from "./types";

/**
 * Carries out a Remote's Command on this Device's real player (the Active Device, or a Device
 * taking a Command back when there turned out to be no Active Device). Indexes are window
 * indexes of the published queue; `windowStart` maps them back to the full queue.
 */
export function executeCommand(command: Command, windowStart = 0) {
	const player = usePlayerStore.getState();
	const at = (i: number) => windowStart + i;
	switch (command.type) {
		case "playQueue":
			player.playQueue(command.tracks.map(toPlayerTrack), command.startIndex);
			return;
		case "pause":
			player.pause();
			return;
		case "resume":
			if (player.currentTrack) player.resume();
			return;
		case "next":
			player.next();
			return;
		case "prev":
			player.prev();
			return;
		case "seek":
			player.seek(command.positionMs / 1000);
			return;
		case "jumpTo":
			player.jumpToIndex(at(command.index));
			return;
		case "addNext":
			player.addNext(toPlayerTrack(command.track));
			return;
		case "addToQueue":
			for (const t of command.tracks) usePlayerStore.getState().addToQueue(toPlayerTrack(t));
			return;
		case "remove":
			player.removeFromQueue(at(command.index));
			return;
		case "move":
			player.moveInQueue(at(command.from), at(command.to));
			return;
		case "clearUpcoming":
			player.clearQueue();
			return;
		case "setShuffle":
			if (player.shuffle !== command.on) player.toggleShuffle();
			return;
		case "setRepeat":
			usePlayerStore.setState({ repeat: command.mode });
			return;
		case "setVolume":
			player.setVolume(Math.round(Math.max(0, Math.min(1, command.volume)) * 100));
			return;
	}
}
