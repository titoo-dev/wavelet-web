import { describe, it, expect, vi, beforeEach } from "vitest";
import { prismaMock, resetPrismaMock } from "@/test/helpers/mockPrisma";
import {
	authMock,
	setSessionUser,
	clearSession,
} from "@/test/helpers/mockAuth";
import { makeNextRequest, readJson } from "@/test/helpers/nextRequest";

vi.mock("@/lib/prisma", () => ({ prisma: prismaMock }));
vi.mock("@/lib/auth", () => ({ auth: authMock }));

const { libraryMock } = vi.hoisted(() => ({
	libraryMock: {
		maybeEvictFile: vi.fn(async (_id: string) => {}),
		getTrackRefCount: vi.fn(),
	},
}));
vi.mock("@/lib/library", () => libraryMock);

import { GET, POST } from "./route";

beforeEach(() => {
	resetPrismaMock();
	clearSession();
	libraryMock.maybeEvictFile.mockReset();
	libraryMock.maybeEvictFile.mockResolvedValue(undefined);
	libraryMock.getTrackRefCount.mockReset();
});

// ────────────────────────────────────────────────────────────
// GET
// ────────────────────────────────────────────────────────────

describe("GET /api/v1/recent-plays", () => {
	it("returns 401 when not authenticated", async () => {
		const res = await GET(makeNextRequest());
		expect(res.status).toBe(401);
		const body = await readJson<{ error: { code: string } }>(res);
		expect(body?.error.code).toBe("NOT_AUTHENTICATED");
	});

	it("returns the user's recent plays sorted by playedAt desc with default limit 50", async () => {
		setSessionUser("u1");
		const rows = [
			{ id: "r1", trackId: "1", playedAt: new Date("2025-01-02") },
			{ id: "r2", trackId: "2", playedAt: new Date("2025-01-01") },
		];
		prismaMock.recentPlay.findMany.mockResolvedValue(rows);

		const res = await GET(makeNextRequest());
		expect(res.status).toBe(200);
		const body = await readJson<{ data: { items: typeof rows } }>(res);
		expect(body?.data.items).toEqual(
			rows.map((r) => ({ ...r, playedAt: r.playedAt.toISOString() }))
		);
		expect(prismaMock.recentPlay.findMany).toHaveBeenCalledWith({
			where: { userId: "u1" },
			orderBy: { playedAt: "desc" },
			take: 50,
		});
	});

	it("honors a custom limit query param", async () => {
		setSessionUser("u1");
		prismaMock.recentPlay.findMany.mockResolvedValue([]);

		await GET(
			makeNextRequest({ url: "http://localhost:3000/api/v1/recent-plays?limit=10" })
		);
		expect(prismaMock.recentPlay.findMany).toHaveBeenCalledWith(
			expect.objectContaining({ take: 10 })
		);
	});

	it("clamps the limit to 100 (cap)", async () => {
		setSessionUser("u1");
		prismaMock.recentPlay.findMany.mockResolvedValue([]);

		await GET(
			makeNextRequest({ url: "http://localhost:3000/api/v1/recent-plays?limit=999" })
		);
		expect(prismaMock.recentPlay.findMany).toHaveBeenCalledWith(
			expect.objectContaining({ take: 100 })
		);
	});

	it("clamps a negative limit to a minimum of 1", async () => {
		setSessionUser("u1");
		prismaMock.recentPlay.findMany.mockResolvedValue([]);

		await GET(
			makeNextRequest({ url: "http://localhost:3000/api/v1/recent-plays?limit=-5" })
		);
		expect(prismaMock.recentPlay.findMany).toHaveBeenCalledWith(
			expect.objectContaining({ take: 1 })
		);
	});

	it("falls back to 50 when limit=0 (parseInt 0 is falsy via ||)", async () => {
		// TODO: limit=0 currently falls back to 50 due to `parseInt(...) || 50`.
		// This freezes that behavior — if a "minimum of 1" semantic is desired,
		// the source needs to use ?? instead of ||.
		setSessionUser("u1");
		prismaMock.recentPlay.findMany.mockResolvedValue([]);

		await GET(
			makeNextRequest({ url: "http://localhost:3000/api/v1/recent-plays?limit=0" })
		);
		expect(prismaMock.recentPlay.findMany).toHaveBeenCalledWith(
			expect.objectContaining({ take: 50 })
		);
	});

	it("falls back to 50 when limit is non-numeric garbage", async () => {
		setSessionUser("u1");
		prismaMock.recentPlay.findMany.mockResolvedValue([]);

		await GET(
			makeNextRequest({ url: "http://localhost:3000/api/v1/recent-plays?limit=abc" })
		);
		expect(prismaMock.recentPlay.findMany).toHaveBeenCalledWith(
			expect.objectContaining({ take: 50 })
		);
	});

	it("returns 500 INTERNAL_ERROR when prisma throws", async () => {
		setSessionUser("u1");
		prismaMock.recentPlay.findMany.mockRejectedValue(new Error("db down"));

		const res = await GET(makeNextRequest());
		expect(res.status).toBe(500);
		const body = await readJson<{ error: { code: string; message: string } }>(
			res
		);
		expect(body?.error.code).toBe("INTERNAL_ERROR");
		// C8: 500s carry a generic message; "db down" is only logged server-side.
		expect(body?.error.message).toBe("An unexpected error occurred.");
		expect(JSON.stringify(body)).not.toContain("db down");
	});
});

// ────────────────────────────────────────────────────────────
// POST
// ────────────────────────────────────────────────────────────

describe("POST /api/v1/recent-plays", () => {
	it("returns 401 when not authenticated", async () => {
		const res = await POST(
			makeNextRequest({ method: "POST", body: { trackId: "1" } })
		);
		expect(res.status).toBe(401);
	});

	it("returns 400 INVALID_BODY when trackId is missing", async () => {
		setSessionUser("u1");
		const res = await POST(makeNextRequest({ method: "POST", body: {} }));
		expect(res.status).toBe(400);
		const body = await readJson<{ error: { code: string } }>(res);
		expect(body?.error.code).toBe("INVALID_BODY");
	});

	it("returns 400 INVALID_BODY when trackId is empty", async () => {
		setSessionUser("u1");
		const res = await POST(
			makeNextRequest({ method: "POST", body: { trackId: "" } })
		);
		expect(res.status).toBe(400);
	});

	it("returns 400 INVALID_BODY when trackId is non-string", async () => {
		setSessionUser("u1");
		const res = await POST(
			makeNextRequest({ method: "POST", body: { trackId: 42 } })
		);
		expect(res.status).toBe(400);
	});

	it("returns 400 INVALID_BODY when body is not JSON", async () => {
		setSessionUser("u1");
		const res = await POST(
			makeNextRequest({
				method: "POST",
				body: "not-json{{",
				headers: { "Content-Type": "application/json" },
			})
		);
		expect(res.status).toBe(400);
		const body = await readJson<{ error: { code: string } }>(res);
		expect(body?.error.code).toBe("INVALID_BODY");
	});

	it("upserts the recent play and returns { logged: true } when under cap", async () => {
		setSessionUser("u1");
		prismaMock.recentPlay.upsert.mockResolvedValue({});
		prismaMock.recentPlay.count.mockResolvedValue(1);

		const res = await POST(
			makeNextRequest({
				method: "POST",
				body: {
					trackId: "track-1",
					title: "Hi",
					artist: "Me",
					album: "Album",
					albumId: "a-1",
					coverUrl: "http://cover",
					duration: 180,
				},
			})
		);
		expect(res.status).toBe(200);
		const body = await readJson<{ data: { logged: boolean } }>(res);
		expect(body?.data).toEqual({ logged: true });

		expect(prismaMock.recentPlay.upsert).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { userId_trackId: { userId: "u1", trackId: "track-1" } },
				create: expect.objectContaining({
					userId: "u1",
					trackId: "track-1",
					title: "Hi",
					artist: "Me",
					album: "Album",
					albumId: "a-1",
					coverUrl: "http://cover",
					duration: 180,
				}),
				update: expect.objectContaining({ playedAt: expect.any(Date) }),
			})
		);
		expect(prismaMock.recentPlay.deleteMany).not.toHaveBeenCalled();
		expect(libraryMock.maybeEvictFile).not.toHaveBeenCalled();
	});

	it("uses default empty/null fields when only trackId is provided", async () => {
		setSessionUser("u1");
		prismaMock.recentPlay.upsert.mockResolvedValue({});
		prismaMock.recentPlay.count.mockResolvedValue(0);

		await POST(
			makeNextRequest({ method: "POST", body: { trackId: "track-1" } })
		);

		const call = prismaMock.recentPlay.upsert.mock.calls[0][0];
		expect(call.create).toMatchObject({
			userId: "u1",
			trackId: "track-1",
			title: "",
			artist: "",
			album: null,
			albumId: null,
			coverUrl: null,
			duration: null,
		});
	});

	it("evicts the oldest entries when cap is exceeded", async () => {
		setSessionUser("u1");
		prismaMock.recentPlay.upsert.mockResolvedValue({});
		prismaMock.recentPlay.count.mockResolvedValue(102); // cap+2
		const oldRows = [
			{ id: "old1", trackId: "t-old1" },
			{ id: "old2", trackId: "t-old2" },
		];
		prismaMock.recentPlay.findMany.mockResolvedValue(oldRows);
		prismaMock.recentPlay.deleteMany.mockResolvedValue({ count: 2 });

		const res = await POST(
			makeNextRequest({ method: "POST", body: { trackId: "fresh" } })
		);
		expect(res.status).toBe(200);

		expect(prismaMock.recentPlay.findMany).toHaveBeenCalledWith({
			where: { userId: "u1" },
			orderBy: { playedAt: "asc" },
			take: 2,
			select: { id: true, trackId: true },
		});
		expect(prismaMock.recentPlay.deleteMany).toHaveBeenCalledWith({
			where: { id: { in: ["old1", "old2"] } },
		});
		expect(libraryMock.maybeEvictFile).toHaveBeenCalledTimes(2);
		expect(libraryMock.maybeEvictFile).toHaveBeenCalledWith("t-old1");
		expect(libraryMock.maybeEvictFile).toHaveBeenCalledWith("t-old2");
	});

	it("swallows individual eviction errors and still succeeds", async () => {
		setSessionUser("u1");
		prismaMock.recentPlay.upsert.mockResolvedValue({});
		prismaMock.recentPlay.count.mockResolvedValue(101);
		prismaMock.recentPlay.findMany.mockResolvedValue([
			{ id: "old1", trackId: "t-old1" },
		]);
		prismaMock.recentPlay.deleteMany.mockResolvedValue({ count: 1 });
		libraryMock.maybeEvictFile.mockRejectedValueOnce(new Error("disk error"));
		// silence the expected console.error
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		const res = await POST(
			makeNextRequest({ method: "POST", body: { trackId: "fresh" } })
		);
		expect(res.status).toBe(200);
		const body = await readJson<{ data: { logged: boolean } }>(res);
		expect(body?.data).toEqual({ logged: true });
		errSpy.mockRestore();
	});

	it("returns 500 INTERNAL_ERROR when upsert throws", async () => {
		setSessionUser("u1");
		prismaMock.recentPlay.upsert.mockRejectedValue(new Error("db oops"));

		const res = await POST(
			makeNextRequest({ method: "POST", body: { trackId: "track-1" } })
		);
		expect(res.status).toBe(500);
		const body = await readJson<{ error: { code: string; message: string } }>(
			res
		);
		expect(body?.error.code).toBe("INTERNAL_ERROR");
	});
});
