import { describe, it, expect, vi, beforeEach } from "vitest";
import { prismaMock, resetPrismaMock } from "@/test/helpers/mockPrisma";
import { authMock, setSessionUser, clearSession } from "@/test/helpers/mockAuth";
import { makeNextRequest, readJson } from "@/test/helpers/nextRequest";

vi.mock("@/lib/prisma", () => ({ prisma: prismaMock }));
vi.mock("@/lib/auth", () => ({ auth: authMock }));
vi.mock("@/lib/library", () => ({ shareTrack: vi.fn() }));
vi.mock("@/lib/deezer-session", () => ({ restoreUserDz: vi.fn() }));

import { GET, POST } from "./route";
import { shareTrack } from "@/lib/library";
import { restoreUserDz } from "@/lib/deezer-session";
import type { Deezer } from "@/lib/deezer";

const shareTrackMock = vi.mocked(shareTrack);
const restoreMock = vi.mocked(restoreUserDz);
const getTrack = vi.fn();
const deezerTrack = {
	title: "Nofy",
	duration: 295,
	artist: { name: "Hosea Marlyn" },
	album: { title: "Fitiavana", cover_medium: "https://cdn-images.dzcdn.net/images/cover/md5/250x250-000000-80-0-0.jpg" },
};

type Body = { data: { shareId: string }; error: { code: string } };

const meta = { trackId: "42", title: "Song", artist: "Band", album: "LP", coverUrl: "https://e-cdns-images.dzcdn.net/images/cover/x/250x250-000000-80-0-0.jpg", duration: 200 };

function post(body: unknown) {
	return POST(makeNextRequest({ method: "POST", body }));
}

beforeEach(() => {
	resetPrismaMock();
	clearSession();
	shareTrackMock.mockReset();
	shareTrackMock.mockImplementation(async (_u, t, o) => ({ shareId: "new", ...t, expiresAt: o?.expiresAt ?? null }) as never);
	prismaMock.sharedTrack.deleteMany.mockResolvedValue({ count: 0 });
	// No Deezer session by default: the client's metadata is used.
	getTrack.mockReset();
	restoreMock.mockReset();
	restoreMock.mockResolvedValue({ status: "no-arl" });
});

describe("POST /api/v1/shares — metadata from Deezer", () => {
	beforeEach(() => {
		setSessionUser("u1");
		prismaMock.sharedTrack.findFirst.mockResolvedValue(null);
		restoreMock.mockResolvedValue({ status: "ok", dz: { api: { getTrack } } as unknown as Deezer });
	});

	it("publishes Deezer's title, artist, album and cover, not the client's (was: any title could be published for a track)", async () => {
		getTrack.mockResolvedValue(deezerTrack);
		const res = await post({ ...meta, title: "Fake", artist: "Someone else", coverUrl: null });
		expect(res.status).toBe(201);
		expect(getTrack).toHaveBeenCalledWith("42");
		expect(shareTrackMock).toHaveBeenCalledWith(
			"u1",
			{ trackId: "42", title: "Nofy", artist: "Hosea Marlyn", album: "Fitiavana", coverUrl: deezerTrack.album.cover_medium, duration: 295 },
			{ expiresAt: null }
		);
	});

	it("needs no client metadata when Deezer knows the track", async () => {
		getTrack.mockResolvedValue(deezerTrack);
		const res = await post({ trackId: "42" });
		expect(res.status).toBe(201);
		expect(shareTrackMock.mock.calls[0][1].title).toBe("Nofy");
	});

	it("falls back to the client's metadata when Deezer can't answer", async () => {
		getTrack.mockRejectedValue(new Error("DataException: no data"));
		const res = await post(meta);
		expect(res.status).toBe(201);
		expect(shareTrackMock.mock.calls[0][1].title).toBe("Song");
	});
});

describe("POST /api/v1/shares", () => {
	it("returns 401 when not authenticated", async () => {
		const res = await post(meta);
		expect(res.status).toBe(401);
	});

	it("returns 400 without a trackId", async () => {
		setSessionUser("u1");
		const res = await post({ title: "Song", artist: "Band" });
		expect(res.status).toBe(400);
		expect((await readJson<Body>(res))?.error.code).toBe("MISSING_TRACK_ID");
	});

	it("refuses a share without title or artist (was: the web dialog sent only trackId, so public pages showed an empty title)", async () => {
		setSessionUser("u1");
		for (const body of [{ trackId: "42" }, { trackId: "42", title: "Song" }, { trackId: "42", title: "  ", artist: "Band" }]) {
			const res = await post(body);
			expect(res.status).toBe(400);
			expect((await readJson<Body>(res))?.error.code).toBe("MISSING_METADATA");
		}
		expect(shareTrackMock).not.toHaveBeenCalled();
	});

	it("stores the track metadata sent by the client", async () => {
		setSessionUser("u1");
		prismaMock.sharedTrack.findFirst.mockResolvedValue(null);
		const res = await post({ ...meta, expiresIn: 24 });
		expect(res.status).toBe(201);
		expect(shareTrackMock).toHaveBeenCalledWith(
			"u1",
			{ trackId: "42", title: "Song", artist: "Band", album: "LP", coverUrl: meta.coverUrl, duration: 200 },
			{ expiresAt: expect.any(Date) }
		);
	});

	it("drops a foreign cover and caps the text it stores (was: any title and any coverUrl went to the public page and the OG renderer)", async () => {
		setSessionUser("u1");
		prismaMock.sharedTrack.findFirst.mockResolvedValue(null);
		const res = await post({ ...meta, title: "x".repeat(500), coverUrl: "https://169.254.169.254/latest", duration: "200" });
		expect(res.status).toBe(201);
		expect(shareTrackMock).toHaveBeenCalledWith(
			"u1",
			{ trackId: "42", title: "x".repeat(200), artist: "Band", album: "LP", coverUrl: null, duration: null },
			{ expiresAt: null }
		);
	});

	it("refuses an invalid expiresIn with 400 (was: NaN → 500 from Prisma, negative → a link born expired)", async () => {
		setSessionUser("u1");
		prismaMock.sharedTrack.findFirst.mockResolvedValue(null);
		for (const expiresIn of ["abc", -5, 0, 24 * 366, "24", true]) {
			const res = await post({ ...meta, expiresIn });
			expect(res.status, String(expiresIn)).toBe(400);
			expect((await readJson<Body>(res))?.error.code).toBe("INVALID_EXPIRY");
		}
		expect(shareTrackMock).not.toHaveBeenCalled();
	});

	it("treats a missing or null expiresIn as a permanent link", async () => {
		setSessionUser("u1");
		prismaMock.sharedTrack.findFirst.mockResolvedValue(null);
		for (const body of [meta, { ...meta, expiresIn: null }]) {
			expect((await post(body)).status).toBe(201);
		}
		for (const call of shareTrackMock.mock.calls) expect(call[2]).toEqual({ expiresAt: null });
	});

	it("answers the winner's link when two creates race (was: a double tap made two links)", async () => {
		setSessionUser("u1");
		const winner = { shareId: "first", trackId: "42", userId: "u1", expiresAt: null };
		prismaMock.sharedTrack.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(winner as never);
		shareTrackMock.mockRejectedValue(Object.assign(new Error("Unique constraint failed"), { code: "P2002" }));
		const res = await post(meta);
		expect(res.status).toBe(200);
		expect((await readJson<Body>(res))?.data.shareId).toBe("first");
	});

	it("reuses the user's live share for the same track", async () => {
		setSessionUser("u1");
		const live = { shareId: "old", trackId: "42", userId: "u1", expiresAt: null };
		prismaMock.sharedTrack.findFirst.mockResolvedValue(live as never);
		const res = await post(meta);
		expect(res.status).toBe(200);
		expect((await readJson<Body>(res))?.data.shareId).toBe("old");
		expect(shareTrackMock).not.toHaveBeenCalled();
	});

	it("never reuses an expired share and creates a fresh link (was: returned the dead link forever)", async () => {
		setSessionUser("u1");
		prismaMock.sharedTrack.findFirst.mockResolvedValue(null);
		const res = await post({ ...meta, expiresIn: 168 });
		expect(res.status).toBe(201);
		expect((await readJson<Body>(res))?.data.shareId).toBe("new");

		const where = prismaMock.sharedTrack.findFirst.mock.calls[0][0]?.where as unknown as { userId: string; trackId: string; OR: unknown };
		expect(where.userId).toBe("u1");
		expect(where.trackId).toBe("42");
		expect(where.OR).toEqual([{ expiresAt: null }, { expiresAt: { gt: expect.any(Date) } }]);
		// The dead links of this user + track are dropped so they stop anchoring the file.
		expect(prismaMock.sharedTrack.deleteMany).toHaveBeenCalledWith({
			where: { userId: "u1", trackId: "42", expiresAt: { lte: expect.any(Date) } },
		});
	});
});

describe("GET /api/v1/shares", () => {
	it("lists the user's shares, newest first", async () => {
		setSessionUser("u1");
		prismaMock.sharedTrack.findMany.mockResolvedValue([{ shareId: "a" }] as never);
		const res = await GET(makeNextRequest());
		expect(res.status).toBe(200);
		expect(prismaMock.sharedTrack.findMany).toHaveBeenCalledWith({ where: { userId: "u1" }, orderBy: { createdAt: "desc" } });
	});
});
