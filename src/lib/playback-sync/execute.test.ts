import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/utils/haptic", () => ({ haptic: vi.fn() }));

import { usePlayerStore, type PlayerTrack } from "@/stores/usePlayerStore";
import { executeCommand } from "./execute";
import { toSessionTrack } from "./track";

const INITIAL = usePlayerStore.getState();
const t = (id: string): PlayerTrack => ({
	trackId: id,
	title: `T${id}`,
	artist: "A",
	artistId: null,
	album: null,
	albumId: null,
	cover: null,
	duration: 200,
});
const ids = () => usePlayerStore.getState().queue.map((x) => x.trackId);

beforeEach(() => {
	usePlayerStore.setState(INITIAL, true);
	usePlayerStore.setState({ queue: [t("1"), t("2"), t("3")], queueIndex: 0, currentTrack: t("1"), isPlaying: true, duration: 200 });
});

describe("executeCommand", () => {
	it("playQueue plays the Remote's queue from its start track", () => {
		executeCommand({ type: "playQueue", tracks: [t("8"), t("9")].map(toSessionTrack), startIndex: 1 });
		expect(ids()).toEqual(["8", "9"]);
		expect(usePlayerStore.getState().currentTrack?.trackId).toBe("9");
	});

	it("pause / resume, and resume only with a track loaded", () => {
		executeCommand({ type: "pause" });
		expect(usePlayerStore.getState().isPlaying).toBe(false);
		executeCommand({ type: "resume" });
		expect(usePlayerStore.getState().isPlaying).toBe(true);
		usePlayerStore.setState({ currentTrack: null, isPlaying: false });
		executeCommand({ type: "resume" });
		expect(usePlayerStore.getState().isPlaying).toBe(false);
	});

	it("next / prev / seek", () => {
		executeCommand({ type: "next" });
		expect(usePlayerStore.getState().queueIndex).toBe(1);
		executeCommand({ type: "prev" });
		expect(usePlayerStore.getState().queueIndex).toBe(0);
		executeCommand({ type: "seek", positionMs: 42_500 });
		expect(usePlayerStore.getState()).toMatchObject({ currentTime: 42.5, _seekTo: 42.5 });
	});

	it("maps window indexes back to the full queue", () => {
		executeCommand({ type: "jumpTo", index: 1 }, 1);
		expect(usePlayerStore.getState().queueIndex).toBe(2);
		executeCommand({ type: "remove", index: 0 }, 1);
		expect(ids()).toEqual(["1", "3"]);
		executeCommand({ type: "move", from: 0, to: 1 }, 0);
		expect(ids()).toEqual(["3", "1"]);
	});

	it("queue edits: addNext, addToQueue, clearUpcoming", () => {
		executeCommand({ type: "addNext", track: toSessionTrack(t("5")) });
		executeCommand({ type: "addToQueue", tracks: [t("6"), t("7")].map(toSessionTrack) });
		expect(ids()).toEqual(["1", "5", "2", "3", "6", "7"]);
		executeCommand({ type: "clearUpcoming" });
		expect(ids()).toEqual(["1"]);
	});

	it("modes and volume", () => {
		executeCommand({ type: "setShuffle", on: true });
		expect(usePlayerStore.getState().shuffle).toBe(true);
		executeCommand({ type: "setShuffle", on: true });
		expect(usePlayerStore.getState().shuffle).toBe(true);
		executeCommand({ type: "setRepeat", mode: "one" });
		expect(usePlayerStore.getState().repeat).toBe("one");
		executeCommand({ type: "setVolume", volume: 0.25 });
		expect(usePlayerStore.getState().volume).toBe(25);
		executeCommand({ type: "setVolume", volume: 7 });
		expect(usePlayerStore.getState().volume).toBe(100);
	});
});
