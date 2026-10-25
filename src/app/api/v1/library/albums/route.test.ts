import { describe, it, expect, vi, beforeEach } from "vitest";
import { prismaMock, resetPrismaMock } from "@/test/helpers/mockPrisma";
import { authMock, setSessionUser, clearSession } from "@/test/helpers/mockAuth";
import { makeNextRequest, readJson } from "@/test/helpers/nextRequest";

vi.mock("@/lib/prisma", () => ({ prisma: prismaMock }));
vi.mock("@/lib/auth", () => ({ auth: authMock }));
vi.mock("@/lib/library", () => ({
	saveAlbum: vi.fn(),
	listSavedAlbums: vi.fn(),
}));

import { GET, POST } from "./route";
import { saveAlbum, listSavedAlbums } from "@/lib/library";

const saveAlbumMock = vi.mocked(saveAlbum);
const listSavedAlbumsMock = vi.mocked(listSavedAlbums);

beforeEach(() => {
	resetPrismaMock();
	clearSession();
	saveAlbumMock.mockReset();
	listSavedAlbumsMock.mockReset();
});

describe("GET /api/v1/library/albums", () => {
	it("returns 401 when not authenticated", async () => {
		const res = await GET(makeNextRequest());
		expect(res.status).toBe(401);
	});

	it("returns saved album items", async () => {
		setSessionUser("u1");
		listSavedAlbumsMock.mockResolvedValue([
			{ id: "a1" },
			{ id: "a2" },
		] as never);

		const res = await GET(makeNextRequest());
		expect(res.status).toBe(200);
		const body = await readJson<{ data: { items: unknown[] } }>(res);
		expect(body?.data.items).toHaveLength(2);
		expect(listSavedAlbumsMock).toHaveBeenCalledWith("u1");
	});

	it("returns 500 when listSavedAlbums throws", async () => {
		setSessionUser("u1");
		listSavedAlbumsMock.mockRejectedValue(new Error("db"));

		const res = await GET(makeNextRequest());
		expect(res.status).toBe(500);
		const body = await readJson<{ error: { code: string } }>(res);
		expect(body?.error.code).toBe("INTERNAL_ERROR");
	});
});

describe("POST /api/v1/library/albums", () => {
	const validBody = {
		deezerAlbumId: "dz-1",
		title: "Album",
		artist: "Artist",
		tracks: [
			{ trackId: "t1", title: "T1", artist: "A1", trackNumber: 1, duration: 200 },
		],
	};

	it("returns 401 when not authenticated", async () => {
		const res = await POST(
			makeNextRequest({ method: "POST", body: validBody })
		);
		expect(res.status).toBe(401);
	});

	it("returns 400 when deezerAlbumId is missing", async () => {
		setSessionUser("u1");
		const res = await POST(
			makeNextRequest({
				method: "POST",
				body: { title: "x", artist: "y", tracks: [] },
			})
		);
		expect(res.status).toBe(400);
		const body = await readJson<{ error: { code: string } }>(res);
		expect(body?.error.code).toBe("INVALID_BODY");
	});

	it("returns 400 when deezerAlbumId is an empty string", async () => {
		setSessionUser("u1");
		const res = await POST(
			makeNextRequest({
				method: "POST",
				body: { deezerAlbumId: "", title: "x", artist: "y", tracks: [] },
			})
		);
		expect(res.status).toBe(400);
	});

	it("returns 400 when title is missing or wrong type", async () => {
		setSessionUser("u1");
		const res = await POST(
			makeNextRequest({
				method: "POST",
				body: { deezerAlbumId: "d", artist: "y", tracks: [] },
			})
		);
		expect(res.status).toBe(400);
	});

	it("returns 400 when artist is missing", async () => {
		setSessionUser("u1");
		const res = await POST(
			makeNextRequest({
				method: "POST",
				body: { deezerAlbumId: "d", title: "x", tracks: [] },
			})
		);
		expect(res.status).toBe(400);
	});

	it("returns 400 when tracks is not an array", async () => {
		setSessionUser("u1");
		const res = await POST(
			makeNextRequest({
				method: "POST",
				body: { deezerAlbumId: "d", title: "x", artist: "y", tracks: "nope" },
			})
		);
		expect(res.status).toBe(400);
	});

	it("calls saveAlbum with normalized fields and returns the saved album", async () => {
		setSessionUser("u1");
		const savedRow = { id: "internal-1" };
		saveAlbumMock.mockResolvedValue(savedRow as never);

		const res = await POST(
			makeNextRequest({
				method: "POST",
				body: {
					deezerAlbumId: "dz-1",
					title: "Album",
					artist: "Artist",
					coverUrl: "http://c",
					tracks: [
						{
							trackId: "t1",
							title: "T1",
							artist: "A1",
							trackNumber: 1,
							duration: 200,
						},
					],
				},
			})
		);
		expect(res.status).toBe(200);
		const body = await readJson<{ data: { saved: unknown } }>(res);
		expect(body?.data.saved).toEqual(savedRow);

		expect(saveAlbumMock).toHaveBeenCalledTimes(1);
		const [userId, albumMeta, tracksMeta] = saveAlbumMock.mock.calls[0];
		expect(userId).toBe("u1");
		expect(albumMeta).toEqual({
			deezerAlbumId: "dz-1",
			title: "Album",
			artist: "Artist",
			coverUrl: "http://c",
		});
		expect(tracksMeta).toEqual([
			{
				trackId: "t1",
				title: "T1",
				artist: "A1",
				coverUrl: null,
				duration: 200,
				trackNumber: 1,
			},
		]);
	});

	it("normalizes track fields (coerces strings, defaults nullables)", async () => {
		setSessionUser("u1");
		saveAlbumMock.mockResolvedValue({ id: "x" } as never);

		await POST(
			makeNextRequest({
				method: "POST",
				body: {
					deezerAlbumId: "dz-1",
					title: "Album",
					artist: "Artist",
					tracks: [
						{ trackId: 42, title: undefined, artist: null },
					],
				},
			})
		);

		const tracksMeta = saveAlbumMock.mock.calls[0][2];
		expect(tracksMeta).toEqual([
			{
				trackId: "42",
				title: "",
				artist: "",
				coverUrl: null,
				duration: null,
				trackNumber: null,
			},
		]);
	});

	it("propagates 500 when saveAlbum throws", async () => {
		setSessionUser("u1");
		saveAlbumMock.mockRejectedValue(new Error("db down"));

		const res = await POST(
			makeNextRequest({ method: "POST", body: validBody })
		);
		expect(res.status).toBe(500);
		const body = await readJson<{ error: { code: string } }>(res);
		expect(body?.error.code).toBe("INTERNAL_ERROR");
	});
});
