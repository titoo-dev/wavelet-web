import { describe, it, expect } from "vitest";
import {
	EMPTY_SIGNALS,
	fromApiTrack,
	pickAutoplay,
	signalsFrom,
	spreadArtists,
	type AutoplayTrack,
	type ListenRow,
} from "./autoplay";

const t = (id: string, artistId: string, title = `Song ${id}`): AutoplayTrack => ({
	trackId: id,
	title,
	artist: `Artist ${artistId}`,
	artistId,
	album: null,
	albumId: null,
	cover: null,
	duration: 200,
});
const ids = (tracks: AutoplayTrack[]) => tracks.map((x) => x.trackId);
const none = { exclude: new Set<string>(), signals: EMPTY_SIGNALS };

describe("fromApiTrack", () => {
	it("maps a Deezer public API track to a queueable track", () => {
		expect(
			fromApiTrack({
				id: 3135556,
				readable: true,
				title: "Harder, Better, Faster, Stronger",
				duration: 226,
				artist: { id: 27, name: "Daft Punk" },
				album: { id: 302127, title: "Discovery", cover_medium: "https://cdn/250.jpg" },
			})
		).toEqual({
			trackId: "3135556",
			title: "Harder, Better, Faster, Stronger",
			artist: "Daft Punk",
			artistId: "27",
			album: "Discovery",
			albumId: "302127",
			cover: "https://cdn/250.jpg",
			duration: 226,
		});
	});

	it("leaves out a track Deezer can't play, or one without id or title", () => {
		expect(fromApiTrack({ id: 1, title: "x", readable: false })).toBeNull();
		expect(fromApiTrack({ title: "x" })).toBeNull();
		expect(fromApiTrack({ id: 1 })).toBeNull();
		expect(fromApiTrack(null)).toBeNull();
	});

	it("tolerates missing artist, album and duration", () => {
		expect(fromApiTrack({ id: 1, title: "x" })).toMatchObject({ artist: "", artistId: null, album: null, cover: null, duration: null });
	});
});

describe("signalsFrom", () => {
	const NOW = Date.parse("2026-10-20T12:00:00Z");
	const row = (over: Partial<ListenRow>): ListenRow => ({
		trackId: "1",
		artistId: "a",
		endReason: "completed",
		msPlayed: 200_000,
		startedAt: new Date(NOW - 24 * 3600_000),
		...over,
	});
	const early = (over: Partial<ListenRow> = {}) => row({ endReason: "skipped", msPlayed: 5000, ...over });

	it("a track skipped early more often than listened to is out; one listened to as often stays", () => {
		const s = signalsFrom([early({ trackId: "1" }), early({ trackId: "2" }), row({ trackId: "2" })], NOW);
		expect([...s.skippedTracks]).toEqual(["1"]);
	});

	it("a skip after 30 s is a listen, not an early skip", () => {
		const s = signalsFrom([row({ endReason: "skipped", msPlayed: 45_000 })], NOW);
		expect(s.skippedTracks.size).toBe(0);
	});

	it("an artist is out after 3 early skips and no listen", () => {
		const skips = [early({ trackId: "1" }), early({ trackId: "2" }), early({ trackId: "3" })];
		expect([...signalsFrom(skips, NOW).skippedArtists]).toEqual(["a"]);
		expect(signalsFrom([...skips, row({ trackId: "4" })], NOW).skippedArtists.size).toBe(0);
		expect(signalsFrom(skips.slice(0, 2), NOW).skippedArtists.size).toBe(0);
	});

	it("failed and transferred plays say nothing about taste", () => {
		const s = signalsFrom(
			[row({ endReason: "failed", msPlayed: 0 }), row({ endReason: "transferred", msPlayed: 1000 })],
			NOW
		);
		expect(s.skippedTracks.size).toBe(0);
	});

	it("tracks played in the last 3 hours are recent, whatever the end", () => {
		const s = signalsFrom(
			[row({ trackId: "1", startedAt: new Date(NOW - 3600_000) }), row({ trackId: "2", startedAt: new Date(NOW - 4 * 3600_000) })],
			NOW
		);
		expect([...s.recentTracks]).toEqual(["1"]);
	});
});

describe("pickAutoplay", () => {
	it("takes the lists in turns, the first leading each round", () => {
		const picked = pickAutoplay([[t("1", "a"), t("2", "b")], [t("3", "c"), t("4", "d")]], { ...none, limit: 4 });
		expect(ids(picked)).toEqual(["1", "3", "2", "4"]);
	});

	it("leaves out queued, skipped and recent tracks, and skipped artists", () => {
		const picked = pickAutoplay([[t("1", "a"), t("2", "b"), t("3", "c"), t("4", "x"), t("5", "d")]], {
			exclude: new Set(["1"]),
			signals: { skippedTracks: new Set(["2"]), recentTracks: new Set(["3"]), skippedArtists: new Set(["x"]) },
			limit: 10,
		});
		expect(ids(picked)).toEqual(["5"]);
	});

	it("has at most 2 tracks per artist, and each song once", () => {
		const picked = pickAutoplay(
			[[t("1", "a"), t("2", "a"), t("3", "a"), t("4", "b", "Song 1 (Remastered)"), t("5", "b", "Song 1")]],
			{ ...none, limit: 10 }
		);
		expect(ids(picked).filter((id) => ["1", "2", "3"].includes(id))).toHaveLength(2);
		expect(ids(picked).filter((id) => ["4", "5"].includes(id))).toHaveLength(1);
	});

	it("stops at the limit, and at the end of every list", () => {
		const list = Array.from({ length: 10 }, (_, i) => t(String(i), `a${i}`));
		expect(pickAutoplay([list], { ...none, limit: 3 })).toHaveLength(3);
		expect(pickAutoplay([list.slice(0, 2), []], { ...none, limit: 20 })).toHaveLength(2);
		expect(pickAutoplay([], { ...none, limit: 20 })).toEqual([]);
	});

	it("the same track in two radios is offered once", () => {
		expect(ids(pickAutoplay([[t("1", "a")], [t("1", "a")]], { ...none, limit: 5 }))).toEqual(["1"]);
	});
});

describe("spreadArtists", () => {
	it("never puts one artist twice in a row when another can go between", () => {
		const out = spreadArtists([t("1", "a"), t("2", "a"), t("3", "b"), t("4", "b"), t("5", "c")]);
		for (let i = 1; i < out.length; i++) expect(out[i].artistId).not.toBe(out[i - 1].artistId);
	});

	it("keeps them together when nothing else is left", () => {
		expect(ids(spreadArtists([t("1", "a"), t("2", "a")]))).toEqual(["1", "2"]);
	});
});
