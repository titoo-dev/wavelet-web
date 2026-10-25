import { describe, it, expect, vi, beforeEach } from "vitest";
import { prismaMock, resetPrismaMock } from "@/test/helpers/mockPrisma";
import { authMock, setSessionUser, clearSession } from "@/test/helpers/mockAuth";
import { makeNextRequest, makeParams, readJson } from "@/test/helpers/nextRequest";

vi.mock("@/lib/prisma", () => ({ prisma: prismaMock }));
vi.mock("@/lib/auth", () => ({ auth: authMock }));
vi.mock("@/lib/library", () => ({
	unsaveAlbum: vi.fn(),
}));

import { GET, DELETE } from "./route";
import { unsaveAlbum } from "@/lib/library";

const unsaveAlbumMock = vi.mocked(unsaveAlbum);

beforeEach(() => {
	resetPrismaMock();
	clearSession();
	unsaveAlbumMock.mockReset();
});

describe("GET /api/v1/library/albums/[albumId]", () => {
	it("returns 401 when not authenticated", async () => {
		const res = await GET(
			makeNextRequest(),
			makeParams({ albumId: "alb-1" })
		);
		expect(res.status).toBe(401);
	});

	it("returns 404 when the album doesn't belong to the user", async () => {
		setSessionUser("u1");
		prismaMock.album.findFirst.mockResolvedValue(null);

		const res = await GET(
			makeNextRequest(),
			makeParams({ albumId: "alb-1" })
		);
		expect(res.status).toBe(404);
		const body = await readJson<{ error: { code: string } }>(res);
		expect(body?.error.code).toBe("NOT_FOUND");
	});

	it("returns the album with tracks ordered by trackNumber asc", async () => {
		setSessionUser("u1");
		const album = {
			id: "alb-1",
			userId: "u1",
			tracks: [{ trackId: "t1", trackNumber: 1 }],
		};
		prismaMock.album.findFirst.mockResolvedValue(album);

		const res = await GET(
			makeNextRequest(),
			makeParams({ albumId: "alb-1" })
		);
		expect(res.status).toBe(200);
		const body = await readJson<{ data: unknown }>(res);
		expect(body?.data).toEqual(album);
		expect(prismaMock.album.findFirst).toHaveBeenCalledWith({
			where: { id: "alb-1", userId: "u1" },
			include: {
				tracks: { orderBy: { trackNumber: "asc" } },
			},
		});
	});
});

describe("DELETE /api/v1/library/albums/[albumId]", () => {
	it("returns 401 when not authenticated", async () => {
		const res = await DELETE(
			makeNextRequest({ method: "DELETE" }),
			makeParams({ albumId: "alb-1" })
		);
		expect(res.status).toBe(401);
	});

	it("returns 404 when the album is not in the user's library", async () => {
		setSessionUser("u1");
		prismaMock.album.findFirst.mockResolvedValue(null);

		const res = await DELETE(
			makeNextRequest({ method: "DELETE" }),
			makeParams({ albumId: "alb-1" })
		);
		expect(res.status).toBe(404);
		const body = await readJson<{ error: { code: string } }>(res);
		expect(body?.error.code).toBe("NOT_FOUND");
		expect(unsaveAlbumMock).not.toHaveBeenCalled();
	});

	it("calls unsaveAlbum with the looked-up deezerAlbumId and returns { unsaved: true }", async () => {
		setSessionUser("u1");
		prismaMock.album.findFirst.mockResolvedValue({
			deezerAlbumId: "dz-99",
		});
		unsaveAlbumMock.mockResolvedValue(undefined);

		const res = await DELETE(
			makeNextRequest({ method: "DELETE" }),
			makeParams({ albumId: "alb-1" })
		);
		expect(res.status).toBe(200);
		const body = await readJson<{ data: { unsaved: boolean } }>(res);
		expect(body?.data.unsaved).toBe(true);

		expect(prismaMock.album.findFirst).toHaveBeenCalledWith({
			where: { id: "alb-1", userId: "u1" },
			select: { deezerAlbumId: true },
		});
		expect(unsaveAlbumMock).toHaveBeenCalledWith("u1", "dz-99");
	});

	it("returns 500 when unsaveAlbum throws", async () => {
		setSessionUser("u1");
		prismaMock.album.findFirst.mockResolvedValue({
			deezerAlbumId: "dz-99",
		});
		unsaveAlbumMock.mockRejectedValue(new Error("boom"));

		const res = await DELETE(
			makeNextRequest({ method: "DELETE" }),
			makeParams({ albumId: "alb-1" })
		);
		expect(res.status).toBe(500);
	});
});
