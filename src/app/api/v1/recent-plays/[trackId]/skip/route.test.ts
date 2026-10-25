import { describe, it, expect, vi, beforeEach } from "vitest";
import { prismaMock, resetPrismaMock } from "@/test/helpers/mockPrisma";
import {
	authMock,
	setSessionUser,
	clearSession,
} from "@/test/helpers/mockAuth";
import {
	makeNextRequest,
	makeParams,
	readJson,
} from "@/test/helpers/nextRequest";

vi.mock("@/lib/prisma", () => ({ prisma: prismaMock }));
vi.mock("@/lib/auth", () => ({ auth: authMock }));

const { libraryMock } = vi.hoisted(() => ({
	libraryMock: {
		maybeEvictFile: vi.fn(),
		getTrackRefCount: vi.fn(),
	},
}));
vi.mock("@/lib/library", () => libraryMock);

import { POST } from "./route";

beforeEach(() => {
	resetPrismaMock();
	clearSession();
	libraryMock.maybeEvictFile.mockReset();
	libraryMock.maybeEvictFile.mockResolvedValue(undefined);
	libraryMock.getTrackRefCount.mockReset();
});

describe("POST /api/v1/recent-plays/[trackId]/skip", () => {
	it("returns 401 when not authenticated", async () => {
		const res = await POST(
			makeNextRequest({ method: "POST" }),
			makeParams({ trackId: "t1" })
		);
		expect(res.status).toBe(401);
		const body = await readJson<{ error: { code: string } }>(res);
		expect(body?.error.code).toBe("NOT_AUTHENTICATED");
	});

	it("returns kept=true reason=already_played when user has played the track before", async () => {
		setSessionUser("u1");
		prismaMock.recentPlay.findUnique.mockResolvedValue({ id: "rp1" });

		const res = await POST(
			makeNextRequest({ method: "POST" }),
			makeParams({ trackId: "t1" })
		);
		expect(res.status).toBe(200);
		const body = await readJson<{ data: { kept: boolean; reason: string } }>(
			res
		);
		expect(body?.data).toEqual({ kept: true, reason: "already_played" });
		expect(libraryMock.getTrackRefCount).not.toHaveBeenCalled();
		expect(libraryMock.maybeEvictFile).not.toHaveBeenCalled();
	});

	it("returns kept=true reason=anchored when other refs exist", async () => {
		setSessionUser("u1");
		prismaMock.recentPlay.findUnique.mockResolvedValue(null);
		libraryMock.getTrackRefCount.mockResolvedValue({ total: 3 });

		const res = await POST(
			makeNextRequest({ method: "POST" }),
			makeParams({ trackId: "t1" })
		);
		expect(res.status).toBe(200);
		const body = await readJson<{ data: { kept: boolean; reason: string } }>(
			res
		);
		expect(body?.data).toEqual({ kept: true, reason: "anchored" });
		expect(libraryMock.maybeEvictFile).not.toHaveBeenCalled();
	});

	it("evicts the file when no prior play and no anchors", async () => {
		setSessionUser("u1");
		prismaMock.recentPlay.findUnique.mockResolvedValue(null);
		libraryMock.getTrackRefCount.mockResolvedValue({ total: 0 });

		const res = await POST(
			makeNextRequest({ method: "POST" }),
			makeParams({ trackId: "t1" })
		);
		expect(res.status).toBe(200);
		const body = await readJson<{ data: { evicted: boolean } }>(res);
		expect(body?.data).toEqual({ evicted: true });
		expect(libraryMock.maybeEvictFile).toHaveBeenCalledWith("t1");
	});

	it.each(["recent", "persisting", "anchored"])(
		"keeps the file when eviction is refused (%s) instead of claiming it was evicted (was: a skip evicted a copy another listener had just started)",
		async (reason) => {
			setSessionUser("u1");
			prismaMock.recentPlay.findUnique.mockResolvedValue(null);
			libraryMock.getTrackRefCount.mockResolvedValue({ total: 0 } as never);
			libraryMock.maybeEvictFile.mockResolvedValue({ evicted: 0, kept: reason } as never);

			const res = await POST(makeNextRequest({ method: "POST" }), makeParams({ trackId: "t1" }));
			const body = await readJson<{ data: { kept: boolean; reason: string } }>(res);
			expect(body?.data).toEqual({ kept: true, reason });
		}
	);

	it("queries with the correct composite key", async () => {
		setSessionUser("u1");
		prismaMock.recentPlay.findUnique.mockResolvedValue({ id: "rp1" });

		await POST(
			makeNextRequest({ method: "POST" }),
			makeParams({ trackId: "t-special" })
		);
		expect(prismaMock.recentPlay.findUnique).toHaveBeenCalledWith({
			where: { userId_trackId: { userId: "u1", trackId: "t-special" } },
			select: { id: true },
		});
	});

	it("returns 500 INTERNAL_ERROR when prisma throws", async () => {
		setSessionUser("u1");
		prismaMock.recentPlay.findUnique.mockRejectedValue(new Error("db down"));

		const res = await POST(
			makeNextRequest({ method: "POST" }),
			makeParams({ trackId: "t1" })
		);
		expect(res.status).toBe(500);
		const body = await readJson<{ error: { code: string; message: string } }>(
			res
		);
		expect(body?.error.code).toBe("INTERNAL_ERROR");
		// C8: 500s carry a generic message; "db down" is only logged server-side.
		expect(body?.error.message).toBe("An unexpected error occurred.");
		expect(JSON.stringify(body)).not.toContain("db down");
	});

	it("returns 500 INTERNAL_ERROR when getTrackRefCount throws", async () => {
		setSessionUser("u1");
		prismaMock.recentPlay.findUnique.mockResolvedValue(null);
		libraryMock.getTrackRefCount.mockRejectedValue(new Error("ref fail"));

		const res = await POST(
			makeNextRequest({ method: "POST" }),
			makeParams({ trackId: "t1" })
		);
		expect(res.status).toBe(500);
	});

	it("returns 500 INTERNAL_ERROR when maybeEvictFile throws", async () => {
		setSessionUser("u1");
		prismaMock.recentPlay.findUnique.mockResolvedValue(null);
		libraryMock.getTrackRefCount.mockResolvedValue({ total: 0 });
		libraryMock.maybeEvictFile.mockRejectedValue(new Error("disk fail"));

		const res = await POST(
			makeNextRequest({ method: "POST" }),
			makeParams({ trackId: "t1" })
		);
		expect(res.status).toBe(500);
	});
});
