import { describe, it, expect, vi, beforeEach } from "vitest";
import { prismaMock, resetPrismaMock } from "@/test/helpers/mockPrisma";
import { authMock, setSessionUser, clearSession } from "@/test/helpers/mockAuth";
import { makeNextRequest, readJson } from "@/test/helpers/nextRequest";

vi.mock("@/lib/prisma", () => ({ prisma: prismaMock }));
vi.mock("@/lib/auth", () => ({ auth: authMock }));

const { dzMock, dzResult } = vi.hoisted(() => {
	const dzMock = { api: { get_artist_radio: vi.fn(), getTrack: vi.fn() } };
	return { dzMock, dzResult: { current: { dz: dzMock as unknown, userId: "u1" as string | null } } };
});

const { similarMock } = vi.hoisted(() => ({ similarMock: vi.fn() }));
vi.mock("@/lib/similar", () => ({ similarLists: similarMock }));

vi.mock("../_lib/helpers", async (importOriginal) => ({
	...(await importOriginal<typeof import("../_lib/helpers")>()),
	getGuestOrUserDz: vi.fn(async () => dzResult.current),
}));

import { POST } from "./route";

const apiTrack = (id: number, artistId: number, extra: Record<string, unknown> = {}) => ({
	id,
	readable: true,
	title: `Song ${id}`,
	duration: 200,
	artist: { id: artistId, name: `Artist ${artistId}` },
	album: { id: 900 + id, title: `Album ${id}`, cover_medium: `https://cdn/${id}.jpg` },
	...extra,
});
const radio = (...tracks: unknown[]) => ({ data: tracks });
const post = (body: unknown) => POST(makeNextRequest({ method: "POST", body }));
type Body = { data: { tracks: { trackId: string; artistId: string }[]; seedArtistIds: string[] }; error: { code: string } };

beforeEach(() => {
	resetPrismaMock();
	clearSession();
	dzMock.api.get_artist_radio.mockReset();
	dzMock.api.getTrack.mockReset();
	dzResult.current = { dz: dzMock, userId: "u1" };
	prismaMock.listenEvent.findMany.mockResolvedValue([]);
	similarMock.mockReset();
	similarMock.mockResolvedValue([]);
	vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("POST /api/v1/autoplay", () => {
	it("returns 401 when not authenticated", async () => {
		const res = await post({ seeds: [{ trackId: "1", artistId: "27" }] });
		expect(res.status).toBe(401);
		expect(dzMock.api.get_artist_radio).not.toHaveBeenCalled();
	});

	it.each([
		["no body", undefined],
		["no seeds", { seeds: [] }],
		["more than 5 seeds", { seeds: Array.from({ length: 6 }, (_, i) => ({ trackId: String(i + 1) })) }],
		["a non-numeric track id", { seeds: [{ trackId: "abc" }] }],
		["a limit above 50", { seeds: [{ trackId: "1" }], limit: 51 }],
	])("returns 400 INVALID_BODY for %s", async (_label, body) => {
		setSessionUser("u1");
		const res = body === undefined ? await POST(makeNextRequest({ method: "POST" })) : await post(body);
		expect(res.status).toBe(400);
		expect((await readJson<Body>(res))?.error.code).toBe("INVALID_BODY");
	});

	it("returns the seed artist's radio, without the seed and what is queued", async () => {
		setSessionUser("u1");
		dzMock.api.get_artist_radio.mockResolvedValue(radio(apiTrack(1, 27), apiTrack(2, 10), apiTrack(3, 11), apiTrack(4, 12)));
		const res = await post({ seeds: [{ trackId: "1", artistId: "27" }], exclude: ["3"] });
		expect(res.status).toBe(200);
		const body = (await readJson<Body>(res))!.data;
		expect(body.tracks.map((t) => t.trackId)).toEqual(["2", "4"]);
		expect(body.tracks[0]).toMatchObject({ artist: "Artist 10", albumId: "902", cover: "https://cdn/2.jpg", duration: 200 });
		expect(body.seedArtistIds).toEqual(["27"]);
		expect(dzMock.api.get_artist_radio).toHaveBeenCalledWith("27", { limit: 40 });
	});

	it("mixes the radios of up to 3 distinct seed artists, most recent first", async () => {
		setSessionUser("u1");
		dzMock.api.get_artist_radio.mockImplementation(async (artistId: string) =>
			radio(apiTrack(Number(artistId) * 10 + 1, Number(artistId) * 100), apiTrack(Number(artistId) * 10 + 2, Number(artistId) * 100 + 1))
		);
		const res = await post({
			seeds: [
				{ trackId: "100", artistId: "1" },
				{ trackId: "101", artistId: "1" },
				{ trackId: "102", artistId: "2" },
				{ trackId: "103", artistId: "3" },
				{ trackId: "104", artistId: "4" },
			],
		});
		const body = (await readJson<Body>(res))!.data;
		expect(body.seedArtistIds).toEqual(["1", "2", "3"]);
		expect(body.tracks.map((t) => t.trackId)).toEqual(["11", "21", "31", "12", "22", "32"]);
	});

	it("looks up the artist of a seed sent without one", async () => {
		setSessionUser("u1");
		dzMock.api.getTrack.mockResolvedValue({ artist: { id: 27 } });
		dzMock.api.get_artist_radio.mockResolvedValue(radio(apiTrack(2, 10)));
		const res = await post({ seeds: [{ trackId: "3135556" }] });
		expect(dzMock.api.getTrack).toHaveBeenCalledWith("3135556");
		expect((await readJson<Body>(res))!.data.seedArtistIds).toEqual(["27"]);
	});

	it("returns 404 when no seed artist can be found", async () => {
		setSessionUser("u1");
		dzMock.api.getTrack.mockRejectedValue(new Error("no data"));
		const res = await post({ seeds: [{ trackId: "1" }] });
		expect(res.status).toBe(404);
	});

	it("leaves out what the user skips early and what they played in the last hours", async () => {
		setSessionUser("u1");
		const now = Date.now();
		prismaMock.listenEvent.findMany.mockResolvedValue([
			{ trackId: "2", artistId: "10", endReason: "skipped", msPlayed: 3000, startedAt: new Date(now - 86400_000) },
			{ trackId: "3", artistId: "11", endReason: "completed", msPlayed: 200_000, startedAt: new Date(now - 600_000) },
		]);
		dzMock.api.get_artist_radio.mockResolvedValue(radio(apiTrack(2, 10), apiTrack(3, 11), apiTrack(4, 12)));
		const res = await post({ seeds: [{ trackId: "1", artistId: "27" }] });
		expect((await readJson<Body>(res))!.data.tracks.map((t) => t.trackId)).toEqual(["4"]);
		expect(prismaMock.listenEvent.findMany.mock.calls[0][0].where.userId).toBe("u1");
	});

	it("goes on with the radios that answered when one fails", async () => {
		setSessionUser("u1");
		dzMock.api.get_artist_radio.mockImplementation(async (artistId: string) => {
			if (artistId === "1") throw new Error("boom");
			return radio(apiTrack(5, 50));
		});
		const res = await post({ seeds: [{ trackId: "100", artistId: "1" }, { trackId: "101", artistId: "2" }] });
		expect(res.status).toBe(200);
		expect((await readJson<Body>(res))!.data.tracks.map((t) => t.trackId)).toEqual(["5"]);
	});

	it("returns 502 when every radio failed", async () => {
		setSessionUser("u1");
		dzMock.api.get_artist_radio.mockRejectedValue(new Error("boom"));
		const res = await post({ seeds: [{ trackId: "1", artistId: "27" }] });
		expect(res.status).toBe(502);
	});

	it("blends ListenBrainz / Last.fm tracks similar to the playing track after the first radio", async () => {
		setSessionUser("u1");
		dzMock.api.get_artist_radio.mockImplementation(async (artistId: string) =>
			radio(apiTrack(Number(artistId) * 10 + 1, Number(artistId) * 100), apiTrack(Number(artistId) * 10 + 2, Number(artistId) * 100 + 1))
		);
		const ext = (id: string) => ({ trackId: id, title: id, artist: `X${id}`, artistId: `x${id}`, album: null, albumId: null, cover: null, duration: 1 });
		similarMock.mockResolvedValue([[ext("lb1"), ext("lb2")]]);
		const res = await post({ seeds: [{ trackId: "100", artistId: "1" }, { trackId: "101", artistId: "2" }] });
		expect((await readJson<Body>(res))!.data.tracks.map((t) => t.trackId)).toEqual(["11", "lb1", "21", "12", "lb2", "22"]);
		expect(similarMock).toHaveBeenCalledWith(dzMock.api, ["100"]);
	});

	it("still answers from the similar tracks when every radio failed", async () => {
		setSessionUser("u1");
		dzMock.api.get_artist_radio.mockRejectedValue(new Error("boom"));
		similarMock.mockResolvedValue([[{ trackId: "lb1", title: "t", artist: "X", artistId: "x", album: null, albumId: null, cover: null, duration: 1 }]]);
		const res = await post({ seeds: [{ trackId: "1", artistId: "27" }] });
		expect(res.status).toBe(200);
		expect((await readJson<Body>(res))!.data.tracks.map((t) => t.trackId)).toEqual(["lb1"]);
	});

	it("returns 503 without any Deezer session", async () => {
		setSessionUser("u1");
		dzResult.current = { dz: null, userId: null };
		const res = await post({ seeds: [{ trackId: "1", artistId: "27" }] });
		expect(res.status).toBe(503);
	});
});
