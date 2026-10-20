import { describe, it, expect, vi, beforeEach } from "vitest";
import { prismaMock, resetPrismaMock } from "@/test/helpers/mockPrisma";
import { authMock, setSessionUser, clearSession } from "@/test/helpers/mockAuth";
import { makeNextRequest, readJson } from "@/test/helpers/nextRequest";

vi.mock("@/lib/prisma", () => ({ prisma: prismaMock }));
vi.mock("@/lib/auth", () => ({ auth: authMock }));

const { dzMock, dzResult } = vi.hoisted(() => {
	const dzMock = {
		api: { get_artist_radio: vi.fn(), get_user_flow: vi.fn() },
		currentUser: { id: 4242 } as { id?: number },
	};
	return { dzMock, dzResult: { current: { dz: dzMock as unknown, userId: "u1" as string | null } } };
});

const { similarMock } = vi.hoisted(() => ({ similarMock: vi.fn() }));
vi.mock("@/lib/similar", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/similar")>()),
	similarLists: similarMock,
}));

vi.mock("../../_lib/helpers", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../_lib/helpers")>()),
	getGuestOrUserDz: vi.fn(async () => dzResult.current),
}));

import { GET } from "./route";

const apiTrack = (id: number, artistId: number, name = `Artist ${artistId}`) => ({
	id,
	readable: true,
	title: `Song ${id}`,
	duration: 200,
	artist: { id: artistId, name },
	album: { id: 900, title: "Album", cover_medium: "https://cdn/c.jpg" },
});
const get = (query = "day=2026-10-20") => GET(makeNextRequest({ url: `http://localhost:3000/api/v1/mixes/daily?${query}` }));
type Mix = { day: string; basedOn: string; artists: string[]; tracks: { trackId: string }[] };
const listen = (artistId: string) => ({ trackId: "x", artistId, endReason: "completed", msPlayed: 200_000, startedAt: new Date() });

beforeEach(() => {
	resetPrismaMock();
	clearSession();
	dzMock.api.get_artist_radio.mockReset();
	dzMock.api.get_user_flow.mockReset();
	dzMock.currentUser = { id: 4242 };
	dzResult.current = { dz: dzMock, userId: "u1" };
	prismaMock.dailyMix.findUnique.mockResolvedValue(null);
	prismaMock.listenEvent.findMany.mockResolvedValue([]);
	prismaMock.followedArtist.findMany.mockResolvedValue([]);
	prismaMock.savedTrack.findMany.mockResolvedValue([]);
	prismaMock.recentPlay.findMany.mockResolvedValue([]);
	similarMock.mockReset();
	similarMock.mockResolvedValue([]);
	vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("GET /api/v1/mixes/daily", () => {
	it("returns 401 when not authenticated", async () => {
		expect((await get()).status).toBe(401);
	});

	it.each(["day=20-10-2026", "day=2026-13-45", "day="])("returns 400 INVALID_DAY for %s", async (q) => {
		setSessionUser("u1");
		const res = await get(q);
		expect(res.status).toBe(400);
		expect((await readJson<{ error: { code: string } }>(res))?.error.code).toBe("INVALID_DAY");
	});

	it("serves today's mix from the cache without asking Deezer", async () => {
		setSessionUser("u1");
		const payload = { day: "2026-10-20", basedOn: "taste", artists: ["A"], tracks: [{ trackId: "1" }] };
		prismaMock.dailyMix.findUnique.mockResolvedValue({ userId: "u1", day: "2026-10-20", payload });
		const res = await get();
		expect((await readJson<{ data: Mix }>(res))?.data).toEqual(payload);
		expect(dzMock.api.get_artist_radio).not.toHaveBeenCalled();
	});

	it("builds the mix from the top artists' radios with their names, and caches it for the day", async () => {
		setSessionUser("u1");
		prismaMock.listenEvent.findMany.mockResolvedValue([listen("27"), listen("27"), listen("10")]);
		prismaMock.followedArtist.findMany.mockResolvedValue([{ deezerArtistId: "6404", name: "Justice" }]);
		prismaMock.savedTrack.findMany.mockResolvedValue([
			{ trackId: "s1", title: "Loved", artist: "Daft Punk", album: null, albumId: null, coverUrl: null, duration: 180 },
		]);
		dzMock.api.get_artist_radio.mockImplementation(async (artistId: string) => ({
			data: [apiTrack(Number(artistId) * 10, Number(artistId), artistId === "27" ? "Daft Punk" : `Artist ${artistId}`), apiTrack(Number(artistId) * 10 + 1, 1)],
		}));
		const res = await get();
		const mix = (await readJson<{ data: Mix }>(res))!.data;
		expect(mix.basedOn).toBe("taste");
		expect(mix.artists).toEqual(["Justice", "Daft Punk", "Artist 10"]);
		expect(mix.tracks.map((t) => t.trackId)).toContain("s1");
		expect(dzMock.api.get_artist_radio.mock.calls.map(([id]) => id)).toEqual(["6404", "27", "10"]);
		expect(prismaMock.dailyMix.upsert).toHaveBeenCalledWith(
			expect.objectContaining({ where: { userId: "u1" }, create: expect.objectContaining({ userId: "u1", day: "2026-10-20" }) })
		);
	});

	it("adds tracks similar to a loved track of the day's artists", async () => {
		setSessionUser("u1");
		prismaMock.followedArtist.findMany.mockResolvedValue([{ deezerArtistId: "27", name: "Daft Punk" }]);
		prismaMock.savedTrack.findMany.mockResolvedValue([
			{ trackId: "s1", title: "Loved", artist: "Daft Punk", album: null, albumId: null, coverUrl: null, duration: 180 },
		]);
		dzMock.api.get_artist_radio.mockResolvedValue({ data: [apiTrack(270, 27, "Daft Punk")] });
		similarMock.mockResolvedValue([[{ trackId: "lb1", title: "t", artist: "X", artistId: "x", album: null, albumId: null, cover: null, duration: 1 }]]);
		const mix = (await readJson<{ data: Mix }>(await get()))!.data;
		expect(similarMock).toHaveBeenCalledWith(dzMock.api, ["s1", "270"]);
		expect(mix.tracks.map((t) => t.trackId)).toContain("lb1");
	});

	it("rebuilds a mix from another day, and on refresh", async () => {
		setSessionUser("u1");
		prismaMock.dailyMix.findUnique.mockResolvedValue({ userId: "u1", day: "2026-10-19", payload: { tracks: [] } });
		prismaMock.followedArtist.findMany.mockResolvedValue([{ deezerArtistId: "27", name: "Daft Punk" }]);
		dzMock.api.get_artist_radio.mockResolvedValue({ data: [apiTrack(1, 5)] });
		await get();
		expect(dzMock.api.get_artist_radio).toHaveBeenCalledTimes(1);
		prismaMock.dailyMix.findUnique.mockResolvedValue({ userId: "u1", day: "2026-10-20", payload: { tracks: [] } });
		await get("day=2026-10-20&refresh=1");
		expect(dzMock.api.get_artist_radio).toHaveBeenCalledTimes(2);
	});

	it("with no history, is the user's Deezer Flow", async () => {
		setSessionUser("u1");
		dzMock.api.get_user_flow.mockResolvedValue({ data: [apiTrack(1, 5), apiTrack(2, 6)] });
		const mix = (await readJson<{ data: Mix }>(await get()))!.data;
		expect(mix.basedOn).toBe("flow");
		expect(mix.tracks.map((t) => t.trackId).sort()).toEqual(["1", "2"]);
		expect(dzMock.api.get_user_flow).toHaveBeenCalledWith(4242, { limit: 50 });
	});

	it("never uses the service account's Flow (was: a guest session would show someone else's taste)", async () => {
		setSessionUser("u1");
		dzResult.current = { dz: dzMock, userId: null };
		const res = await get();
		expect((await readJson<{ data: Mix }>(res))!.data.tracks).toEqual([]);
		expect(dzMock.api.get_user_flow).not.toHaveBeenCalled();
		expect(prismaMock.dailyMix.upsert).not.toHaveBeenCalled();
	});

	it("keeps yesterday's mix when today's can't be built", async () => {
		setSessionUser("u1");
		const old = { day: "2026-10-19", basedOn: "taste", artists: [], tracks: [{ trackId: "9" }] };
		prismaMock.dailyMix.findUnique.mockResolvedValue({ userId: "u1", day: "2026-10-19", payload: old });
		prismaMock.followedArtist.findMany.mockResolvedValue([{ deezerArtistId: "27", name: "Daft Punk" }]);
		dzMock.api.get_artist_radio.mockRejectedValue(new Error("down"));
		expect((await readJson<{ data: Mix }>(await get()))!.data).toEqual(old);
		dzResult.current = { dz: null, userId: null };
		expect((await readJson<{ data: Mix }>(await get()))!.data).toEqual(old);
	});

	it("returns 503 without Deezer and nothing cached", async () => {
		setSessionUser("u1");
		dzResult.current = { dz: null, userId: null };
		expect((await get()).status).toBe(503);
	});

	it("survives a failed Flow: an empty mix", async () => {
		setSessionUser("u1");
		dzMock.api.get_user_flow.mockRejectedValue(new Error("down"));
		const res = await get();
		expect(res.status).toBe(200);
		expect((await readJson<{ data: Mix }>(res))!.data.tracks).toEqual([]);
	});
});
