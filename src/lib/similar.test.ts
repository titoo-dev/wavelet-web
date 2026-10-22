import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
	PER_SOURCE,
	TtlCache,
	lastFmSimilar,
	listenBrainzSimilar,
	normName,
	recordingMbid,
	resetSimilarCaches,
	resolveOnDeezer,
	similarLists,
	type SimilarApi,
} from "./similar";

const deezerTrack = (id: number, artist: string, title: string) => ({
	id,
	readable: true,
	title,
	duration: 200,
	artist: { id: id + 1000, name: artist },
	album: { id: 9, title: "Album", cover_medium: "https://cdn/c.jpg" },
});

let fetchMock: ReturnType<typeof vi.fn>;
const routes: Record<string, unknown> = {};
const urls = () => fetchMock.mock.calls.map(([u]) => String(u));

function api(over: Partial<Record<keyof SimilarApi, ReturnType<typeof vi.fn>>> = {}): SimilarApi & Record<string, ReturnType<typeof vi.fn>> {
	return {
		getTrack: vi.fn(async () => ({ title: "Harder, Better, Faster, Stronger", isrc: "GBDUW0000059", artist: { name: "Daft Punk" } })),
		search: vi.fn(async (q: string) => {
			if (/^justice/i.test(q)) return { data: [deezerTrack(1, "Justice Tribute Band", "D.A.N.C.E."), deezerTrack(2, "Justice", "D.A.N.C.E.")] };
			if (/^mgmt/i.test(q)) return { data: [deezerTrack(3, "MGMT", "Kids (Remastered)")] };
			return { data: [] };
		}),
		...over,
	} as never;
}

beforeEach(() => {
	resetSimilarCaches();
	for (const k of Object.keys(routes)) delete routes[k];
	routes["musicbrainz.org"] = { recordings: [{ id: "mbid-hbfs" }] };
	routes["labs.api.listenbrainz.org"] = [
		{ recording_name: "Kids", artist_credit_name: "MGMT", score: 400 },
		{ recording_name: "D.A.N.C.E.", artist_credit_name: "Justice", score: 600 },
		{ recording_name: "", artist_credit_name: "Nobody", score: 900 },
	];
	routes["ws.audioscrobbler.com"] = { similartracks: { track: [{ name: "Kids", artist: { name: "MGMT" } }] } };
	fetchMock = vi.fn(async (url: string) => {
		const host = new URL(url).host;
		return host in routes ? Response.json(routes[host]) : new Response("nope", { status: 503 });
	});
	vi.stubGlobal("fetch", fetchMock);
	vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
	vi.unstubAllGlobals();
	delete process.env.LASTFM_API_KEY;
});

describe("normName", () => {
	it("compares names without case, accents, punctuation or (versions)", () => {
		expect(normName("Beyoncé")).toBe("beyonce");
		expect(normName("Kids (Remastered 2019)")).toBe("kids");
		expect(normName("D.A.N.C.E.")).toBe("d a n c e");
	});
});

describe("TtlCache", () => {
	it("forgets after its time, and drops the oldest past its size", () => {
		const c = new TtlCache<number>(1000, 2);
		c.set("a", 1, 0);
		expect(c.get("a", 500)).toBe(1);
		expect(c.get("a", 1500)).toBeUndefined();
		c.set("a", 1, 0);
		c.set("b", 2, 0);
		c.set("c", 3, 0);
		expect(c.get("a", 0)).toBeUndefined();
		expect(c.get("c", 0)).toBe(3);
	});
});

describe("ListenBrainz", () => {
	it("finds the MusicBrainz recording of an ISRC, once per ISRC, with a User-Agent", async () => {
		expect(await recordingMbid("GBDUW0000059")).toBe("mbid-hbfs");
		await recordingMbid("GBDUW0000059");
		expect(urls()).toEqual(["https://musicbrainz.org/ws/2/isrc/GBDUW0000059?fmt=json"]);
		expect((fetchMock.mock.calls[0][1] as RequestInit).headers).toMatchObject({ "User-Agent": expect.stringMatching(/^Wavelet\//) });
	});

	it("returns the similar recordings best score first, without nameless ones", async () => {
		expect(await listenBrainzSimilar("mbid-hbfs")).toEqual([
			{ artist: "Justice", title: "D.A.N.C.E." },
			{ artist: "MGMT", title: "Kids" },
		]);
		expect(urls()[0]).toMatch(/similar-recordings\/json\?recording_mbids=mbid-hbfs&algorithm=session_based/);
	});

	it("an unknown ISRC has no recording", async () => {
		routes["musicbrainz.org"] = { recordings: [] };
		expect(await recordingMbid("XX")).toBeNull();
	});
});

describe("Last.fm", () => {
	it("is off without LASTFM_API_KEY", async () => {
		expect(await lastFmSimilar({ artist: "Daft Punk", title: "One More Time" })).toBeNull();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("asks track.getSimilar with the key", async () => {
		expect(await lastFmSimilar({ artist: "Daft Punk", title: "One More Time" }, "k")).toEqual([{ artist: "MGMT", title: "Kids" }]);
		const url = new URL(urls()[0]);
		expect(url.searchParams.get("method")).toBe("track.getsimilar");
		expect(url.searchParams.get("api_key")).toBe("k");
		expect(url.searchParams.get("track")).toBe("One More Time");
	});

	it("a Last.fm error is an error", async () => {
		routes["ws.audioscrobbler.com"] = { error: 10, message: "Invalid API key" };
		await expect(lastFmSimilar({ artist: "A", title: "B" }, "bad")).rejects.toThrow(/Last.fm error 10/);
	});
});

describe("resolveOnDeezer", () => {
	it("takes the result by that artist with that title, not a tribute band", async () => {
		const a = api();
		expect((await resolveOnDeezer(a, { artist: "Justice", title: "D.A.N.C.E." }))?.trackId).toBe("2");
		expect(a.search).toHaveBeenCalledWith("Justice D.A.N.C.E.", { limit: 5 });
	});

	it("accepts another version of the same title, and remembers the answer", async () => {
		const a = api();
		expect((await resolveOnDeezer(a, { artist: "mgmt", title: "Kids" }))?.trackId).toBe("3");
		await resolveOnDeezer(a, { artist: "MGMT", title: "Kids" });
		expect(a.search).toHaveBeenCalledTimes(1);
	});

	it("takes the main artist of a credit with featured artists", async () => {
		expect((await resolveOnDeezer(api(), { artist: "MGMT feat. Someone", title: "Kids" }))?.trackId).toBe("3");
	});

	it("is null when Deezer has no such track", async () => {
		expect(await resolveOnDeezer(api(), { artist: "Nobody", title: "Nothing" })).toBeNull();
	});
});

describe("similarLists", () => {
	it("gives ListenBrainz then Last.fm tracks, resolved on Deezer", async () => {
		process.env.LASTFM_API_KEY = "k";
		const lists = await similarLists(api(), ["3135556"]);
		expect(lists.map((l) => l.map((t) => t.trackId))).toEqual([["2", "3"], ["3"]]);
	});

	it("leaves out a source that fails, and a seed Deezer doesn't know", async () => {
		routes["labs.api.listenbrainz.org"] = undefined as never;
		delete routes["labs.api.listenbrainz.org"];
		const a = api({ getTrack: vi.fn(async () => { throw new Error("no data"); }) });
		expect(await similarLists(a, ["1"])).toEqual([]);
		expect(await similarLists(api(), ["3135556"])).toEqual([]);
	});

	it("skips ListenBrainz for a seed without ISRC", async () => {
		const a = api({ getTrack: vi.fn(async () => ({ title: "x", artist: { name: "y" } })) });
		expect(await similarLists(a, ["1"])).toEqual([]);
		expect(urls().some((u) => u.includes("musicbrainz"))).toBe(false);
	});

	it(`resolves at most ${PER_SOURCE} tracks per source`, async () => {
		routes["labs.api.listenbrainz.org"] = Array.from({ length: 30 }, (_, i) => ({ recording_name: `S${i}`, artist_credit_name: `A${i}`, score: 100 - i }));
		const a = api();
		await similarLists(a, ["3135556"]);
		expect(a.search).toHaveBeenCalledTimes(PER_SOURCE);
	});
});
