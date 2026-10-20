import { describe, expect, it } from "vitest";
import type { PlayerTrack } from "@/stores/usePlayerStore";
import { extrapolate, MAX_QUEUE, ServerClock, toPlayerTrack, toSession, toSessionTrack, windowStartFor } from "./track";

const t = (id: string): PlayerTrack => ({ trackId: id, title: `T${id}`, artist: "A", cover: null, duration: 200 });

describe("toSessionTrack", () => {
	it("keeps only the fields Convex stores (was: an API payload's extra fields made the publish fail)", () => {
		const fromApi = { ...t("1"), previewUrl: "x", rank: 3 } as PlayerTrack;
		expect(toSessionTrack(fromApi)).toEqual({
			trackId: "1",
			title: "T1",
			artist: "A",
			artistId: null,
			album: null,
			albumId: null,
			cover: null,
			duration: 200,
		});
	});

	it("drops a duration that is not a finite number", () => {
		expect(toSessionTrack({ ...t("1"), duration: NaN }).duration).toBeNull();
		expect(toSessionTrack({ ...t("1"), duration: null }).duration).toBeNull();
	});

	it("round-trips through toPlayerTrack", () => {
		const track = { ...t("1"), artistId: "9", album: "Al", albumId: "7", cover: "c" };
		expect(toPlayerTrack(toSessionTrack(track))).toEqual(track);
	});

	it("fills missing optional fields with null", () => {
		expect(toPlayerTrack({ trackId: "1", title: "T", artist: "A" })).toEqual({
			trackId: "1",
			title: "T",
			artist: "A",
			artistId: null,
			album: null,
			albumId: null,
			cover: null,
			duration: null,
		});
	});
});

describe("windowStartFor", () => {
	it("is 0 while the queue fits in one window", () => {
		expect(windowStartFor(MAX_QUEUE, 900)).toBe(0);
	});

	it("keeps 100 played tracks behind the current one", () => {
		expect(windowStartFor(3000, 500)).toBe(400);
	});

	it("never runs past the end of the queue", () => {
		expect(windowStartFor(3000, 2990)).toBe(2000);
	});

	it("starts at 0 near the beginning or with nothing loaded", () => {
		expect(windowStartFor(3000, 50)).toBe(0);
		expect(windowStartFor(3000, -1)).toBe(0);
	});
});

describe("toSession", () => {
	const base = { isPlaying: true, currentTime: 12.3456, shuffle: true, repeat: "all" as const };

	it("publishes the queue window and the index inside it", () => {
		const queue = Array.from({ length: 1500 }, (_, i) => t(String(i)));
		const { state, queue: q } = toSession({ ...base, queue, queueIndex: 700, currentTrack: queue[700] });
		expect(q.windowStart).toBe(500);
		expect(q.tracks).toHaveLength(MAX_QUEUE);
		expect(state).toMatchObject({ index: 200, isPlaying: true, positionMs: 12346, shuffle: true, repeat: "all" });
		expect(q.tracks[state.index].trackId).toBe("700");
	});

	it("is not playing, at index -1, with nothing loaded", () => {
		const { state } = toSession({ ...base, queue: [], queueIndex: -1, currentTrack: null });
		expect(state).toMatchObject({ index: -1, currentTrack: null, isPlaying: false });
	});

	it("never publishes a negative position", () => {
		expect(toSession({ ...base, currentTime: -3, queue: [t("1")], queueIndex: 0, currentTrack: t("1") }).state.positionMs).toBe(0);
		expect(toSession({ ...base, currentTime: NaN, queue: [t("1")], queueIndex: 0, currentTrack: t("1") }).state.positionMs).toBe(0);
	});
});

describe("extrapolate", () => {
	const s = { index: 0, currentTrack: toSessionTrack(t("1")), isPlaying: true, positionMs: 10_000, shuffle: false, repeat: "off" as const };

	it("moves on while playing", () => {
		expect(extrapolate(s, 1_000, 3_500)).toBe(12.5);
	});

	it("stays put while paused", () => {
		expect(extrapolate({ ...s, isPlaying: false }, 1_000, 9_000)).toBe(10);
	});

	it("stops at the end of the track", () => {
		expect(extrapolate(s, 0, 999_999)).toBe(200);
	});

	it("has no end when the duration is unknown, and never goes back", () => {
		const unknown = { ...s, currentTrack: { ...s.currentTrack, duration: null } };
		expect(extrapolate(unknown, 0, 500_000)).toBe(510);
		expect(extrapolate(s, 5_000, 1_000)).toBe(10);
	});
});

describe("ServerClock", () => {
	it("takes the server's time as this tab's until it saw one", () => {
		expect(new ServerClock().toLocal(5_000)).toBe(5_000);
	});

	it("keeps the least late of the recent samples, so a stale one does not count", () => {
		const clock = new ServerClock();
		clock.observe(100_000, 40_200); // fresh: 200 ms late on a clock 60 s behind
		clock.observe(85_000, 40_500); // a snapshot 15 s old
		expect(clock.toLocal(100_000)).toBe(40_200);
		for (let i = 0; i < 8; i++) clock.observe(200_000, 140_400);
		expect(clock.toLocal(200_000)).toBe(140_400);
	});
});
