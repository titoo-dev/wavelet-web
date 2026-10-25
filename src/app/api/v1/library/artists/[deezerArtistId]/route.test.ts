import { describe, it, expect, vi, beforeEach } from "vitest";
import { prismaMock, resetPrismaMock } from "@/test/helpers/mockPrisma";
import { authMock, setSessionUser, clearSession } from "@/test/helpers/mockAuth";
import { makeNextRequest, makeParams, readJson } from "@/test/helpers/nextRequest";

vi.mock("@/lib/prisma", () => ({ prisma: prismaMock }));
vi.mock("@/lib/auth", () => ({ auth: authMock }));
vi.mock("@/lib/library", () => ({
	unfollowArtist: vi.fn(),
}));

import { DELETE } from "./route";
import { unfollowArtist } from "@/lib/library";

const unfollowArtistMock = vi.mocked(unfollowArtist);

beforeEach(() => {
	resetPrismaMock();
	clearSession();
	unfollowArtistMock.mockReset();
});

describe("DELETE /api/v1/library/artists/[deezerArtistId]", () => {
	it("returns 401 when not authenticated", async () => {
		const res = await DELETE(
			makeNextRequest({ method: "DELETE" }),
			makeParams({ deezerArtistId: "27" })
		);
		expect(res.status).toBe(401);
		expect(unfollowArtistMock).not.toHaveBeenCalled();
	});

	it("forwards the upstream Deezer id to unfollowArtist and returns 200 with unfollowed: true", async () => {
		setSessionUser("u1");
		unfollowArtistMock.mockResolvedValue(undefined);

		const res = await DELETE(
			makeNextRequest({ method: "DELETE" }),
			makeParams({ deezerArtistId: "27" })
		);
		expect(res.status).toBe(200);
		const body = await readJson<{ data: { unfollowed: boolean } }>(res);
		expect(body?.data.unfollowed).toBe(true);
		expect(unfollowArtistMock).toHaveBeenCalledWith("u1", "27");
	});

	it("is idempotent — returns 200 even when the user wasn't following the artist", async () => {
		setSessionUser("u1");
		unfollowArtistMock.mockResolvedValue(undefined);

		const res = await DELETE(
			makeNextRequest({ method: "DELETE" }),
			makeParams({ deezerArtistId: "doesnotexist" })
		);
		expect(res.status).toBe(200);
	});

	it("returns 500 when unfollowArtist throws", async () => {
		setSessionUser("u1");
		unfollowArtistMock.mockRejectedValue(new Error("db"));

		const res = await DELETE(
			makeNextRequest({ method: "DELETE" }),
			makeParams({ deezerArtistId: "27" })
		);
		expect(res.status).toBe(500);
		const body = await readJson<{ error: { code: string } }>(res);
		expect(body?.error.code).toBe("INTERNAL_ERROR");
	});
});
