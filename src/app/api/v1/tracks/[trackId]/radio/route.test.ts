import { describe, it, expect, vi, beforeEach } from "vitest";
import { prismaMock, resetPrismaMock } from "@/test/helpers/mockPrisma";
import { authMock, setSessionUser, clearSession } from "@/test/helpers/mockAuth";
import { makeNextRequest, makeParams, readJson } from "@/test/helpers/nextRequest";

vi.mock("@/lib/prisma", () => ({ prisma: prismaMock }));
vi.mock("@/lib/auth", () => ({ auth: authMock }));

const { dzMock, dzResult } = vi.hoisted(() => {
	const dzMock = { api: { get_artist_radio: vi.fn(), getTrack: vi.fn() } };
	return { dzMock, dzResult: { current: { dz: dzMock as unknown, userId: "u1" as string | null } } };
});

const { similarMock } = vi.hoisted(() => ({ similarMock: vi.fn() }));
vi.mock("@/lib/similar", () => ({ similarLists: similarMock }));

vi.mock("../../../_lib/helpers", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../../_lib/helpers")>()),
	getGuestOrUserDz: vi.fn(async () => dzResult.current),
}));

import { GET } from "./route";

const apiTrack = (id: number, artistId: number, extra: Record<string, unknown> = {}) => ({
	id,
	readable: true,
	title: `Song ${id}`,
	duration: 200,
	artist: { id: artistId, name: `Artist ${artistId}` },
	album: { id: 900 + id, title: `Album ${id}`, cover_medium: `https://cdn/${id}.jpg` },
	...extra,
});
const ext = (id: string) => ({ trackId: id, title: id, artist: `X${id}`, artistId: `x${id}`, album: null, albumId: null, cover: null, duration: 1 });
const radio = (...tracks: unknown[]) => ({ data: tracks });
const get = (trackId: string, query = "") =>
	GET(makeNextRequest({ url: `http://localhost:3000/api/v1/tracks/${trackId}/radio${query}` }), makeParams({ trackId }));
type Body = {
	data: { seed: { trackId: string; artist: string; cover: string }; tracks: { trackId: string; artistId: string }[] };
	error: { code: string };
};

beforeEach(() => {
	resetPrismaMock();
	clearSession();
	dzMock.api.get_artist_radio.mockReset();
	dzMock.api.getTrack.mockReset();
	dzMock.api.getTrack.mockResolvedValue(apiTrack(1, 27));
	dzResult.current = { dz: dzMock, userId: "u1" };
	prismaMock.listenEvent.findMany.mockResolvedValue([]);
	similarMock.mockReset();
	similarMock.mockResolvedValue([]);
	vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("GET /api/v1/tracks/[trackId]/radio", () => {
	it("returns 401 when not authenticated", async () => {
		const res = await get("1");
		expect(res.status).toBe(401);
		expect(dzMock.api.getTrack).not.toHaveBeenCalled();
	});

	it("returns 400 INVALID_TRACK_ID for a non-numeric id", async () => {
		setSessionUser("u1");
		const res = await get("abc");
		expect(res.status).toBe(400);
		expect((await readJson<Body>(res))?.error.code).toBe("INVALID_TRACK_ID");
	});

	it.each(["0", "51", "2.5", "x"])("returns 400 INVALID_LIMIT for limit=%s", async (limit) => {
		setSessionUser("u1");
		const res = await get("1", `?limit=${limit}`);
		expect(res.status).toBe(400);
		expect((await readJson<Body>(res))?.error.code).toBe("INVALID_LIMIT");
	});

	it("returns the seed and its artist's radio, without the seed itself", async () => {
		setSessionUser("u1");
		dzMock.api.get_artist_radio.mockResolvedValue(radio(apiTrack(1, 27), apiTrack(2, 10), apiTrack(3, 11)));
		const res = await get("1");
		expect(res.status).toBe(200);
		const body = (await readJson<Body>(res))!.data;
		expect(body.seed).toMatchObject({ trackId: "1", artist: "Artist 27", cover: "https://cdn/1.jpg" });
		expect(body.tracks.map((t) => t.trackId)).toEqual(["2", "3"]);
		expect(dzMock.api.getTrack).toHaveBeenCalledWith("1");
		expect(dzMock.api.get_artist_radio).toHaveBeenCalledWith("27", { limit: 50 });
	});

	it("leads with ListenBrainz / Last.fm tracks similar to this one, the artist radio filling in", async () => {
		setSessionUser("u1");
		dzMock.api.get_artist_radio.mockResolvedValue(radio(apiTrack(2, 10), apiTrack(3, 11), apiTrack(4, 12)));
		similarMock.mockResolvedValue([[ext("lb1"), ext("lb2")], [ext("lfm1")]]);
		const res = await get("1");
		expect((await readJson<Body>(res))!.data.tracks.map((t) => t.trackId)).toEqual(["lb1", "lfm1", "2", "lb2", "3", "4"]);
		expect(similarMock).toHaveBeenCalledWith(dzMock.api, ["1"]);
	});

	it("keeps at most `limit` tracks and 2 per artist", async () => {
		setSessionUser("u1");
		dzMock.api.get_artist_radio.mockResolvedValue(
			radio(apiTrack(2, 10), apiTrack(3, 10), apiTrack(4, 10), apiTrack(5, 11), apiTrack(6, 12), apiTrack(7, 13))
		);
		const res = await get("1", "?limit=4");
		const ids = (await readJson<Body>(res))!.data.tracks.map((t) => t.trackId);
		expect(ids).toHaveLength(4);
		expect(ids).not.toContain("4");
	});

	it("leaves out what the user skips early", async () => {
		setSessionUser("u1");
		prismaMock.listenEvent.findMany.mockResolvedValue([
			{ trackId: "2", artistId: "10", endReason: "skipped", msPlayed: 3000, startedAt: new Date(Date.now() - 86400_000) },
		]);
		dzMock.api.get_artist_radio.mockResolvedValue(radio(apiTrack(2, 10), apiTrack(3, 11)));
		const res = await get("1");
		expect((await readJson<Body>(res))!.data.tracks.map((t) => t.trackId)).toEqual(["3"]);
		expect(prismaMock.listenEvent.findMany.mock.calls[0][0].where.userId).toBe("u1");
	});

	it("returns 404 when Deezer doesn't know the track", async () => {
		setSessionUser("u1");
		dzMock.api.getTrack.mockRejectedValue(new Error("no data"));
		const res = await get("1");
		expect(res.status).toBe(404);
		expect(dzMock.api.get_artist_radio).not.toHaveBeenCalled();
	});

	it("still answers from the similar tracks when the radio failed", async () => {
		setSessionUser("u1");
		dzMock.api.get_artist_radio.mockRejectedValue(new Error("boom"));
		similarMock.mockResolvedValue([[ext("lb1")]]);
		const res = await get("1");
		expect(res.status).toBe(200);
		expect((await readJson<Body>(res))!.data.tracks.map((t) => t.trackId)).toEqual(["lb1"]);
	});

	it("returns 502 when nothing answered", async () => {
		setSessionUser("u1");
		dzMock.api.get_artist_radio.mockRejectedValue(new Error("boom"));
		const res = await get("1");
		expect(res.status).toBe(502);
	});

	it("returns 503 without any Deezer session", async () => {
		setSessionUser("u1");
		dzResult.current = { dz: null, userId: null };
		const res = await get("1");
		expect(res.status).toBe(503);
	});
});
