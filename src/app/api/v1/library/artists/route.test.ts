import { describe, it, expect, vi, beforeEach } from "vitest";
import { prismaMock, resetPrismaMock } from "@/test/helpers/mockPrisma";
import { authMock, setSessionUser, clearSession } from "@/test/helpers/mockAuth";
import { makeNextRequest, readJson } from "@/test/helpers/nextRequest";

vi.mock("@/lib/prisma", () => ({ prisma: prismaMock }));
vi.mock("@/lib/auth", () => ({ auth: authMock }));
vi.mock("@/lib/library", () => ({
	followArtist: vi.fn(),
	listFollowedArtists: vi.fn(),
}));

import { GET, POST } from "./route";
import { followArtist, listFollowedArtists } from "@/lib/library";

const followArtistMock = vi.mocked(followArtist);
const listFollowedArtistsMock = vi.mocked(listFollowedArtists);

beforeEach(() => {
	resetPrismaMock();
	clearSession();
	followArtistMock.mockReset();
	listFollowedArtistsMock.mockReset();
});

describe("GET /api/v1/library/artists", () => {
	it("returns 401 when not authenticated", async () => {
		const res = await GET(makeNextRequest());
		expect(res.status).toBe(401);
	});

	it("returns the user's followed artists in items[]", async () => {
		setSessionUser("u1");
		listFollowedArtistsMock.mockResolvedValue([
			{ id: "f1", deezerArtistId: "27", name: "Daft Punk" },
			{ id: "f2", deezerArtistId: "55", name: "Aphex Twin" },
		] as never);

		const res = await GET(makeNextRequest());
		expect(res.status).toBe(200);
		const body = await readJson<{ data: { items: unknown[] } }>(res);
		expect(body?.data.items).toHaveLength(2);
		expect(listFollowedArtistsMock).toHaveBeenCalledWith("u1");
	});

	it("returns 500 when listFollowedArtists throws", async () => {
		setSessionUser("u1");
		listFollowedArtistsMock.mockRejectedValue(new Error("db"));

		const res = await GET(makeNextRequest());
		expect(res.status).toBe(500);
		const body = await readJson<{ error: { code: string } }>(res);
		expect(body?.error.code).toBe("INTERNAL_ERROR");
	});
});

describe("POST /api/v1/library/artists", () => {
	const validBody = {
		deezerArtistId: "27",
		name: "Daft Punk",
		pictureUrl: "http://cdn/27.jpg",
	};

	it("returns 401 when not authenticated", async () => {
		const res = await POST(makeNextRequest({ method: "POST", body: validBody }));
		expect(res.status).toBe(401);
	});

	it("returns 400 when deezerArtistId is missing", async () => {
		setSessionUser("u1");
		const res = await POST(
			makeNextRequest({ method: "POST", body: { name: "x" } })
		);
		expect(res.status).toBe(400);
		const body = await readJson<{ error: { code: string } }>(res);
		expect(body?.error.code).toBe("INVALID_BODY");
	});

	it("returns 400 when name is missing", async () => {
		setSessionUser("u1");
		const res = await POST(
			makeNextRequest({ method: "POST", body: { deezerArtistId: "27" } })
		);
		expect(res.status).toBe(400);
	});

	it("returns 400 when body is not JSON", async () => {
		setSessionUser("u1");
		const res = await POST(
			makeNextRequest({ method: "POST", body: "not-json" })
		);
		expect(res.status).toBe(400);
	});

	it("forwards the upsert call to followArtist and echoes the row", async () => {
		setSessionUser("u1");
		const row = { id: "f1", userId: "u1", deezerArtistId: "27" };
		followArtistMock.mockResolvedValue(row as never);

		const res = await POST(makeNextRequest({ method: "POST", body: validBody }));
		expect(res.status).toBe(200);
		const body = await readJson<{ data: { followed: unknown } }>(res);
		expect(body?.data.followed).toEqual(row);
		expect(followArtistMock).toHaveBeenCalledWith("u1", {
			deezerArtistId: "27",
			name: "Daft Punk",
			pictureUrl: "http://cdn/27.jpg",
		});
	});

	it("normalizes a missing pictureUrl to null before calling followArtist", async () => {
		setSessionUser("u1");
		followArtistMock.mockResolvedValue({} as never);

		await POST(
			makeNextRequest({
				method: "POST",
				body: { deezerArtistId: "27", name: "Daft Punk" },
			})
		);

		expect(followArtistMock).toHaveBeenCalledWith("u1", {
			deezerArtistId: "27",
			name: "Daft Punk",
			pictureUrl: null,
		});
	});
});
