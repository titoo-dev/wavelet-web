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

import { GET, PATCH } from "./route";

beforeEach(() => {
	resetPrismaMock();
	clearSession();
});

// ────────────────────────────────────────────────────────────
// GET
// ────────────────────────────────────────────────────────────

describe("GET /api/v1/preferences", () => {
	it("returns 401 when not authenticated", async () => {
		const res = await GET(makeNextRequest());
		expect(res.status).toBe(401);
		const body = await readJson<{ error: { code: string } }>(res);
		expect(body?.error.code).toBe("NOT_AUTHENTICATED");
	});

	it("returns the user's preferences when present", async () => {
		setSessionUser("u1");
		prismaMock.userPreferences.findUnique.mockResolvedValue({
			userId: "u1",
			preferences: { playlistSortOrder: "asc", preCacheSaved: true },
		});

		const res = await GET(makeNextRequest());
		expect(res.status).toBe(200);
		const body = await readJson<{
			data: { playlistSortOrder?: string; preCacheSaved?: boolean };
		}>(res);
		expect(body?.data).toEqual({
			playlistSortOrder: "asc",
			preCacheSaved: true,
		});
		expect(prismaMock.userPreferences.findUnique).toHaveBeenCalledWith({
			where: { userId: "u1" },
		});
	});

	it("returns an empty object when no preferences row exists", async () => {
		setSessionUser("u1");
		prismaMock.userPreferences.findUnique.mockResolvedValue(null);

		const res = await GET(makeNextRequest());
		expect(res.status).toBe(200);
		const body = await readJson<{ data: object }>(res);
		expect(body?.data).toEqual({});
	});

	it("returns an empty object when row exists but preferences is null", async () => {
		setSessionUser("u1");
		prismaMock.userPreferences.findUnique.mockResolvedValue({
			userId: "u1",
			preferences: null,
		});

		const res = await GET(makeNextRequest());
		expect(res.status).toBe(200);
		const body = await readJson<{ data: object }>(res);
		expect(body?.data).toEqual({});
	});

	it("returns 500 INTERNAL_ERROR when prisma throws", async () => {
		setSessionUser("u1");
		prismaMock.userPreferences.findUnique.mockRejectedValue(
			new Error("db down")
		);

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
// PATCH
// ────────────────────────────────────────────────────────────

describe("PATCH /api/v1/preferences", () => {
	it("returns 401 when not authenticated", async () => {
		const res = await PATCH(
			makeNextRequest({ method: "PATCH", body: { playlistSortOrder: "asc" } })
		);
		expect(res.status).toBe(401);
	});

	it("rejects unknown keys with 400 INVALID_KEY", async () => {
		setSessionUser("u1");

		const res = await PATCH(
			makeNextRequest({
				method: "PATCH",
				body: { hackerKey: "yes" },
			})
		);
		expect(res.status).toBe(400);
		const body = await readJson<{ error: { code: string; message: string } }>(
			res
		);
		expect(body?.error.code).toBe("INVALID_KEY");
		expect(body?.error.message).toContain("hackerKey");
		expect(prismaMock.userPreferences.upsert).not.toHaveBeenCalled();
	});

	it("merges updates into existing preferences and upserts", async () => {
		setSessionUser("u1");
		prismaMock.userPreferences.findUnique.mockResolvedValue({
			userId: "u1",
			preferences: { playlistSortOrder: "asc", preCacheSaved: false },
		});
		prismaMock.userPreferences.upsert.mockResolvedValue({
			userId: "u1",
			preferences: {
				playlistSortOrder: "desc",
				preCacheSaved: false,
			},
		});

		const res = await PATCH(
			makeNextRequest({
				method: "PATCH",
				body: { playlistSortOrder: "desc" },
			})
		);
		expect(res.status).toBe(200);

		expect(prismaMock.userPreferences.upsert).toHaveBeenCalledWith({
			where: { userId: "u1" },
			update: {
				preferences: { playlistSortOrder: "desc", preCacheSaved: false },
			},
			create: {
				userId: "u1",
				preferences: { playlistSortOrder: "desc", preCacheSaved: false },
			},
		});

		const body = await readJson<{
			data: { playlistSortOrder?: string; preCacheSaved?: boolean };
		}>(res);
		expect(body?.data).toEqual({
			playlistSortOrder: "desc",
			preCacheSaved: false,
		});
	});

	it("creates a new row with just the updates when no existing row", async () => {
		setSessionUser("u1");
		prismaMock.userPreferences.findUnique.mockResolvedValue(null);
		prismaMock.userPreferences.upsert.mockResolvedValue({
			userId: "u1",
			preferences: { albumSortOrder: "desc" },
		});

		await PATCH(
			makeNextRequest({
				method: "PATCH",
				body: { albumSortOrder: "desc" },
			})
		);

		expect(prismaMock.userPreferences.upsert).toHaveBeenCalledWith({
			where: { userId: "u1" },
			update: { preferences: { albumSortOrder: "desc" } },
			create: {
				userId: "u1",
				preferences: { albumSortOrder: "desc" },
			},
		});
	});

	it("accepts all allowed keys: playlistSortOrder / albumSortOrder / preCacheSaved", async () => {
		setSessionUser("u1");
		prismaMock.userPreferences.findUnique.mockResolvedValue(null);
		prismaMock.userPreferences.upsert.mockResolvedValue({
			userId: "u1",
			preferences: {
				playlistSortOrder: "desc",
				albumSortOrder: "asc",
				preCacheSaved: true,
			},
		});

		const res = await PATCH(
			makeNextRequest({
				method: "PATCH",
				body: {
					playlistSortOrder: "desc",
					albumSortOrder: "asc",
					preCacheSaved: true,
				},
			})
		);
		expect(res.status).toBe(200);
	});

	it("returns 500 INTERNAL_ERROR when upsert throws", async () => {
		setSessionUser("u1");
		prismaMock.userPreferences.findUnique.mockResolvedValue(null);
		prismaMock.userPreferences.upsert.mockRejectedValue(new Error("write fail"));

		const res = await PATCH(
			makeNextRequest({
				method: "PATCH",
				body: { playlistSortOrder: "desc" },
			})
		);
		expect(res.status).toBe(500);
		const body = await readJson<{ error: { code: string; message: string } }>(
			res
		);
		expect(body?.error.code).toBe("INTERNAL_ERROR");
	});
});
