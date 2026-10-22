import { describe, it, expect } from "vitest";
import { EMPTY_SIGNALS, type AutoplayTrack, type ListenRow } from "./autoplay";
import { buildDailyMix, dayNumber, flowMix, seededShuffle, seedsOfDay, topArtists, type ArtistScore } from "./daily-mix";

const t = (id: string, artist: string, artistId: string | null = artist): AutoplayTrack => ({
	trackId: id,
	title: `Song ${id}`,
	artist,
	artistId,
	album: null,
	albumId: null,
	cover: null,
	duration: 200,
});
const ids = (tracks: AutoplayTrack[]) => tracks.map((x) => x.trackId);
const row = (artistId: string, endReason: string, msPlayed = 200_000): ListenRow => ({
	trackId: `${artistId}-${Math.random()}`,
	artistId,
	endReason,
	msPlayed,
	startedAt: new Date("2026-10-19T12:00:00Z"),
});

describe("topArtists", () => {
	it("scores listens to the end 2, heard 1, early skips -1, a follow 5, best first", () => {
		const top = topArtists(
			[row("a", "completed"), row("a", "completed"), row("b", "skipped", 40_000), row("c", "skipped", 2000), row("c", "completed")],
			[{ deezerArtistId: "d", name: "Dee" }]
		);
		expect(top.map((s) => [s.artistId, s.score])).toEqual([
			["d", 5],
			["a", 4],
			["b", 1],
			["c", 1],
		]);
		expect(top[0].name).toBe("Dee");
	});

	it("leaves out artists skipped more than heard, and failed or transferred plays", () => {
		const top = topArtists([row("a", "skipped", 1000), row("a", "skipped", 1000), row("a", "completed"), row("b", "failed"), row("c", "transferred")], []);
		expect(top).toEqual([]);
	});
});

describe("seedsOfDay", () => {
	const top = (n: number): ArtistScore[] => Array.from({ length: n }, (_, i) => ({ artistId: `a${i}`, name: null, score: 100 - i }));

	it("uses every artist when there are 3 or fewer", () => {
		expect(seedsOfDay(top(2), "2026-10-20").map((s) => s.artistId)).toEqual(["a0", "a1"]);
	});

	it("moves a window of 3 through the top 9, a different one each day", () => {
		const days = ["2026-10-20", "2026-10-21", "2026-10-22"].map((d) => seedsOfDay(top(12), d).map((s) => s.artistId));
		expect(new Set(days.flat()).size).toBe(9);
		for (const d of days) expect(d).toHaveLength(3);
		expect(days.flat().every((id) => Number(id.slice(1)) < 9)).toBe(true);
	});

	it("is the same all day", () => {
		expect(seedsOfDay(top(9), "2026-10-20")).toEqual(seedsOfDay(top(9), "2026-10-20"));
	});

	it("counts days from the epoch", () => {
		expect(dayNumber("1970-01-02")).toBe(1);
	});
});

describe("seededShuffle", () => {
	const items = Array.from({ length: 20 }, (_, i) => i);

	it("gives the same order for the same seed and another for another seed", () => {
		expect(seededShuffle(items, "u1:2026-10-20")).toEqual(seededShuffle(items, "u1:2026-10-20"));
		expect(seededShuffle(items, "u1:2026-10-21")).not.toEqual(seededShuffle(items, "u1:2026-10-20"));
		expect([...seededShuffle(items, "x")].sort((a, b) => a - b)).toEqual(items);
	});
});

describe("buildDailyMix", () => {
	const radio = (artist: string, n: number, from = 0) => Array.from({ length: n }, (_, i) => t(`${artist}${from + i}`, `Artist ${artist}${i % 6}`, `${artist}${i % 6}`));

	it("is about a third loved tracks by the seed artists, the rest discoveries, 30 in all", () => {
		const familiar = [
			...Array.from({ length: 20 }, (_, i) => t(`f${i}`, "Daft Punk", null)),
			t("x1", "Someone Else", null),
		];
		const mix = buildDailyMix({
			familiar,
			seedNames: ["daft punk", "Justice"],
			radios: [radio("p", 40), radio("j", 40)],
			signals: EMPTY_SIGNALS,
			seed: "u1:2026-10-20",
		});
		expect(mix).toHaveLength(30);
		const loved = mix.filter((x) => x.trackId.startsWith("f"));
		expect(loved).toHaveLength(10);
		expect(ids(mix)).not.toContain("x1");
	});

	it("never offers as a discovery a track the user already has, nor a skipped one", () => {
		const mix = buildDailyMix({
			familiar: [t("p0", "Not a seed", null)],
			seedNames: ["Artist p0"],
			radios: [[t("p0", "Artist p0"), t("p1", "Artist p1"), t("p2", "Artist p2")]],
			signals: { ...EMPTY_SIGNALS, skippedTracks: new Set(["p2"]) },
			seed: "s",
		});
		expect(ids(mix)).toEqual(["p1"]);
	});

	it("keeps tracks played a moment ago: the mix is built once for the day", () => {
		const mix = buildDailyMix({
			familiar: [],
			seedNames: [],
			radios: [[t("p1", "A")]],
			signals: { ...EMPTY_SIGNALS, recentTracks: new Set(["p1"]) },
			seed: "s",
		});
		expect(ids(mix)).toEqual(["p1"]);
	});

	it("is the same all day for one user", () => {
		const input = { familiar: [], seedNames: [], radios: [radio("p", 40)], signals: EMPTY_SIGNALS };
		expect(buildDailyMix({ ...input, seed: "u1:d" })).toEqual(buildDailyMix({ ...input, seed: "u1:d" }));
	});

	it("is only loved tracks when the radios gave nothing", () => {
		const mix = buildDailyMix({ familiar: [t("f1", "A", null)], seedNames: ["A"], radios: [[]], signals: EMPTY_SIGNALS, seed: "s" });
		expect(ids(mix)).toEqual(["f1"]);
	});
});

describe("flowMix", () => {
	it("is the Flow without skips, at most 3 per artist", () => {
		const flow = [t("1", "A"), t("2", "A"), t("3", "A"), t("4", "A"), t("5", "B")];
		const mix = flowMix(flow, { ...EMPTY_SIGNALS, skippedTracks: new Set(["5"]) });
		expect(ids(mix).sort()).toEqual(["1", "2", "3"]);
	});
});
