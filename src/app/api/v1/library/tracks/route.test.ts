import { describe, it, expect, vi, beforeEach } from "vitest";
import { prismaMock, resetPrismaMock } from "@/test/helpers/mockPrisma";
import { authMock, setSessionUser, clearSession } from "@/test/helpers/mockAuth";
import { makeNextRequest, readJson } from "@/test/helpers/nextRequest";

vi.mock("@/lib/prisma", () => ({ prisma: prismaMock }));
vi.mock("@/lib/auth", () => ({ auth: authMock }));
vi.mock("@/lib/library", () => ({
	saveTrack: vi.fn(),
	listSavedTracks: vi.fn(),
	isPreCacheEnabled: vi.fn(async () => false),
}));

import { GET, POST } from "./route";
import { saveTrack, listSavedTracks, isPreCacheEnabled } from "@/lib/library";

const saveTrackMock = vi.mocked(saveTrack);
const listSavedTracksMock = vi.mocked(listSavedTracks);
const isPreCacheEnabledMock = vi.mocked(isPreCacheEnabled);

beforeEach(() => {
	resetPrismaMock();
	clearSession();
	saveTrackMock.mockReset();
	listSavedTracksMock.mockReset();
	isPreCacheEnabledMock.mockReset();
	isPreCacheEnabledMock.mockResolvedValue(false);
});

describe("GET /api/v1/library/tracks", () => {
	it("returns 401 when not authenticated", async () => {
		const res = await GET(makeNextRequest());
		expect(res.status).toBe(401);
		const body = await readJson<{ error: { code: string } }>(res);
		expect(body?.error.code).toBe("NOT_AUTHENTICATED");
	});

	it("returns saved track items in an envelope", async () => {
		setSessionUser("u1");
		listSavedTracksMock.mockResolvedValue([
			{ id: "s1", trackId: "t1" },
			{ id: "s2", trackId: "t2" },
		] as never);

		const res = await GET(makeNextRequest());
		expect(res.status).toBe(200);
		const body = await readJson<{ data: { items: unknown[] } }>(res);
		expect(body?.data.items).toHaveLength(2);
		expect(listSavedTracksMock).toHaveBeenCalledWith("u1", {
			limit: 100,
			offset: 0,
		});
	});

	it("uses default limit=100 when no query params are supplied", async () => {
		setSessionUser("u1");
		listSavedTracksMock.mockResolvedValue([]);

		await GET(makeNextRequest());
		expect(listSavedTracksMock).toHaveBeenCalledWith("u1", {
			limit: 100,
			offset: 0,
		});
	});

	it("falls back to default limit=100 when limit=0 (parseInt('0') is falsy → default branch)", async () => {
		// Current behavior: `parseInt("0") || 100` evaluates to 100, then clamp keeps 100.
		// TODO: limit=0 arguably should clamp to 1 (the documented lower bound).
		setSessionUser("u1");
		listSavedTracksMock.mockResolvedValue([]);

		await GET(
			makeNextRequest({
				url: "http://localhost/test?limit=0",
			})
		);
		expect(listSavedTracksMock).toHaveBeenCalledWith("u1", {
			limit: 100,
			offset: 0,
		});
	});

	it("clamps a negative limit (-5) up to 1", async () => {
		setSessionUser("u1");
		listSavedTracksMock.mockResolvedValue([]);

		await GET(
			makeNextRequest({
				url: "http://localhost/test?limit=-5",
			})
		);
		expect(listSavedTracksMock).toHaveBeenCalledWith("u1", {
			limit: 1,
			offset: 0,
		});
	});

	it("clamps limit=10000 to 500 (upper bound)", async () => {
		setSessionUser("u1");
		listSavedTracksMock.mockResolvedValue([]);

		await GET(
			makeNextRequest({
				url: "http://localhost/test?limit=10000",
			})
		);
		expect(listSavedTracksMock).toHaveBeenCalledWith("u1", {
			limit: 500,
			offset: 0,
		});
	});

	it("passes a valid mid-range limit untouched", async () => {
		setSessionUser("u1");
		listSavedTracksMock.mockResolvedValue([]);

		await GET(
			makeNextRequest({
				url: "http://localhost/test?limit=200&offset=50",
			})
		);
		expect(listSavedTracksMock).toHaveBeenCalledWith("u1", {
			limit: 200,
			offset: 50,
		});
	});

	it("clamps negative offset to 0", async () => {
		setSessionUser("u1");
		listSavedTracksMock.mockResolvedValue([]);

		await GET(
			makeNextRequest({
				url: "http://localhost/test?offset=-5",
			})
		);
		expect(listSavedTracksMock).toHaveBeenCalledWith("u1", {
			limit: 100,
			offset: 0,
		});
	});

	it("returns 500 when listSavedTracks throws", async () => {
		setSessionUser("u1");
		listSavedTracksMock.mockRejectedValue(new Error("db down"));

		const res = await GET(makeNextRequest());
		expect(res.status).toBe(500);
		const body = await readJson<{ error: { code: string } }>(res);
		expect(body?.error.code).toBe("INTERNAL_ERROR");
	});
});

describe("POST /api/v1/library/tracks", () => {
	it("returns 401 when not authenticated", async () => {
		const res = await POST(
			makeNextRequest({
				method: "POST",
				body: { trackId: "t1", title: "Hi", artist: "A" },
			})
		);
		expect(res.status).toBe(401);
	});

	it("returns 400 when trackId is missing", async () => {
		setSessionUser("u1");
		const res = await POST(
			makeNextRequest({
				method: "POST",
				body: { title: "Hi", artist: "A" },
			})
		);
		expect(res.status).toBe(400);
		const body = await readJson<{ error: { code: string } }>(res);
		expect(body?.error.code).toBe("INVALID_BODY");
	});

	it("returns 400 when trackId is the wrong type", async () => {
		setSessionUser("u1");
		const res = await POST(
			makeNextRequest({
				method: "POST",
				body: { trackId: 123, title: "Hi", artist: "A" },
			})
		);
		expect(res.status).toBe(400);
	});

	it("returns 400 when trackId is an empty string", async () => {
		setSessionUser("u1");
		const res = await POST(
			makeNextRequest({
				method: "POST",
				body: { trackId: "", title: "Hi", artist: "A" },
			})
		);
		expect(res.status).toBe(400);
	});

	it("returns 400 when title is not a string", async () => {
		setSessionUser("u1");
		const res = await POST(
			makeNextRequest({
				method: "POST",
				body: { trackId: "t1", title: 123, artist: "A" },
			})
		);
		expect(res.status).toBe(400);
	});

	it("returns 400 when artist is missing", async () => {
		setSessionUser("u1");
		const res = await POST(
			makeNextRequest({
				method: "POST",
				body: { trackId: "t1", title: "Hi" },
			})
		);
		expect(res.status).toBe(400);
	});

	it("calls saveTrack with normalized fields and returns the saved row", async () => {
		setSessionUser("u1");
		const savedRow = { id: "s1", trackId: "t1" };
		saveTrackMock.mockResolvedValue(savedRow as never);

		const res = await POST(
			makeNextRequest({
				method: "POST",
				body: {
					trackId: "t1",
					title: "Hi",
					artist: "A",
					album: "Album",
					albumId: "alb1",
					coverUrl: "http://c",
					duration: 200,
				},
			})
		);
		expect(res.status).toBe(200);
		const body = await readJson<{ data: { saved: unknown } }>(res);
		expect(body?.data.saved).toEqual(savedRow);
		expect(saveTrackMock).toHaveBeenCalledWith("u1", {
			trackId: "t1",
			title: "Hi",
			artist: "A",
			album: "Album",
			albumId: "alb1",
			coverUrl: "http://c",
			duration: 200,
		});
	});

	it("normalizes missing optional fields to null", async () => {
		setSessionUser("u1");
		saveTrackMock.mockResolvedValue({ id: "s1" } as never);

		await POST(
			makeNextRequest({
				method: "POST",
				body: { trackId: "t1", title: "Hi", artist: "A" },
			})
		);
		expect(saveTrackMock).toHaveBeenCalledWith("u1", {
			trackId: "t1",
			title: "Hi",
			artist: "A",
			album: null,
			albumId: null,
			coverUrl: null,
			duration: null,
		});
	});

	it("returns 400 INVALID_BODY when the request body is not valid JSON", async () => {
		setSessionUser("u1");
		const req = makeNextRequest({
			method: "POST",
			body: "{not json",
			headers: { "Content-Type": "application/json" },
		});

		const res = await POST(req);
		expect(res.status).toBe(400);
		const body = await readJson<{ error: { code: string } }>(res);
		expect(body?.error.code).toBe("INVALID_BODY");
	});
});
