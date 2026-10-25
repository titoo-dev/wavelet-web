import { describe, it, expect, vi, beforeEach } from "vitest";
import { prismaMock, resetPrismaMock } from "@/test/helpers/mockPrisma";
import { authMock, setSessionUser, clearSession } from "@/test/helpers/mockAuth";
import { makeNextRequest, makeParams, readJson } from "@/test/helpers/nextRequest";
import { StorageNotFoundError } from "@/lib/wavelet/storage/objects";

vi.mock("@/lib/prisma", () => ({ prisma: prismaMock }));
vi.mock("@/lib/auth", () => ({ auth: authMock }));
vi.mock("@/lib/object-stream", () => ({
	getPresignedUrl: vi.fn(),
}));
const { serverStateMock } = vi.hoisted(() => ({ serverStateMock: { getWaveletApp: vi.fn() } }));
vi.mock("@/lib/server-state", () => serverStateMock);

import { GET } from "./route";
import { getPresignedUrl } from "@/lib/object-stream";

const getPresignedUrlMock = vi.mocked(getPresignedUrl);

describe("GET /api/v1/stream-url/[trackId]", () => {
	beforeEach(() => {
		resetPrismaMock();
		clearSession();
		getPresignedUrlMock.mockReset();
		delete process.env.WAVELET_DISABLE_PRESIGNED_URLS;
	});

	it("returns 401 when not authenticated", async () => {
		const res = await GET(makeNextRequest(), makeParams({ trackId: "1" }));
		expect(res.status).toBe(401);
		const body = await readJson<{ error: { code: string } }>(res);
		expect(body?.error.code).toBe("NOT_AUTHENTICATED");
	});

	it("returns null url when track is not in the cache", async () => {
		setSessionUser("u1");
		prismaMock.storedTrack.findMany.mockResolvedValue([]);

		const res = await GET(makeNextRequest(), makeParams({ trackId: "1" }));
		expect(res.status).toBe(200);
		const body = await readJson<{ data: { url: null; status: string } }>(res);
		expect(body?.data.url).toBeNull();
		expect(body?.data.status).toBe("not_cached");
	});

	it("returns null url when presigned URLs are globally disabled", async () => {
		setSessionUser("u1");
		process.env.WAVELET_DISABLE_PRESIGNED_URLS = "1";

		const res = await GET(makeNextRequest(), makeParams({ trackId: "1" }));
		expect(res.status).toBe(200);
		const body = await readJson<{ data: { url: null; status: string } }>(res);
		expect(body?.data.url).toBeNull();
		expect(body?.data.status).toBe("presigned_disabled");
		expect(prismaMock.storedTrack.findMany).not.toHaveBeenCalled();
	});

	it("returns null url when the cached row predates Blob (s3 / local)", async () => {
		setSessionUser("u1");
		prismaMock.storedTrack.findMany.mockResolvedValue([{
			id: "x",
			trackId: "1",
			bitrate: 320,
			storagePath: "wavelet-music/foo.mp3",
			storageType: "s3",
		}]);

		const res = await GET(makeNextRequest(), makeParams({ trackId: "1" }));
		expect(res.status).toBe(200);
		const body = await readJson<{ data: { url: null; status: string } }>(res);
		expect(body?.data.url).toBeNull();
		expect(body?.data.status).toBe("unsupported_storage");
		expect(getPresignedUrlMock).not.toHaveBeenCalled();
	});

	it("returns a presigned url when the track is cached in Blob", async () => {
		setSessionUser("u1");
		prismaMock.storedTrack.findMany.mockResolvedValue([{
			id: "x",
			trackId: "1",
			bitrate: 320,
			storagePath: "music/foo.mp3",
			storageType: "r2",
		}]);
		getPresignedUrlMock.mockResolvedValue({
			url: "https://example.com/foo.mp3?sig=abc",
			contentType: "audio/mpeg",
		});

		const res = await GET(makeNextRequest(), makeParams({ trackId: "1" }));
		expect(res.status).toBe(200);
		const body = await readJson<{ data: { url: string; contentType: string } }>(res);
		expect(body?.data.url).toContain("example.com");
		expect(body?.data.contentType).toBe("audio/mpeg");
		// C1: one hour (was 900 s).
		expect(getPresignedUrlMock).toHaveBeenCalledWith("music/foo.mp3", 3600);
	});

	it("reports when the presigned URL expires, one hour ahead (was: 900 s URLs expired mid-track and the client could not tell)", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date("2026-10-04T10:00:00.000Z"));
		try {
			setSessionUser("u1");
			prismaMock.storedTrack.findMany.mockResolvedValue([
				{ id: "x", trackId: "1", bitrate: 1, storagePath: "tracks/1/1.mp3", storageType: "r2" },
			]);
			getPresignedUrlMock.mockResolvedValue({ url: "https://example.com/1.mp3", contentType: "audio/mpeg" } as never);

			const res = await GET(makeNextRequest(), makeParams({ trackId: "1" }));
			const body = await readJson<{ data: { url: string; contentType: string; expiresAt: string } }>(res);
			expect(body?.data).toEqual({
				url: "https://example.com/1.mp3",
				contentType: "audio/mpeg",
				expiresAt: "2026-10-04T11:00:00.000Z",
			});
			expect(getPresignedUrlMock).toHaveBeenCalledWith("tracks/1/1.mp3", 3600);
		} finally {
			vi.useRealTimers();
		}
	});

	it("never reports an expiry later than the signature's (was: up to 1 s late, X-Amz-Date is whole seconds)", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		// The signer stamps X-Amz-Date 20261004T100000Z: the URL lapses at 11:00:00.000.
		vi.setSystemTime(new Date("2026-10-04T10:00:00.700Z"));
		try {
			setSessionUser("u1");
			prismaMock.storedTrack.findMany.mockResolvedValue([
				{ id: "x", trackId: "1", bitrate: 1, storagePath: "tracks/1/1.mp3", storageType: "r2" },
			]);
			getPresignedUrlMock.mockResolvedValue({ url: "https://example.com/1.mp3", contentType: "audio/mpeg" } as never);

			const res = await GET(makeNextRequest(), makeParams({ trackId: "1" }));
			const body = await readJson<{ data: { expiresAt: string } }>(res);
			expect(body?.data.expiresAt).toBe("2026-10-04T11:00:00.000Z");
		} finally {
			vi.useRealTimers();
		}
	});

	it("returns null url when signing reports the blob is missing", async () => {
		setSessionUser("u1");
		prismaMock.storedTrack.findMany.mockResolvedValue([{
			id: "x",
			trackId: "1",
			bitrate: 320,
			storagePath: "music/foo.mp3",
			storageType: "r2",
		}]);
		getPresignedUrlMock.mockRejectedValue(new StorageNotFoundError("music/foo.mp3"));

		const res = await GET(makeNextRequest(), makeParams({ trackId: "1" }));
		expect(res.status).toBe(200);
		const body = await readJson<{ data: { url: null; status: string } }>(res);
		expect(body?.data.url).toBeNull();
		expect(body?.data.status).toBe("file_missing");
	});

	it("surfaces other signing failures as 500 INTERNAL_ERROR", async () => {
		setSessionUser("u1");
		prismaMock.storedTrack.findMany.mockResolvedValue([{
			id: "x",
			trackId: "1",
			bitrate: 320,
			storagePath: "music/foo.mp3",
			storageType: "r2",
		}]);
		getPresignedUrlMock.mockRejectedValue(new Error("No token found"));

		const res = await GET(makeNextRequest(), makeParams({ trackId: "1" }));
		expect(res.status).toBe(500);
		const body = await readJson<{ error: { code: string } }>(res);
		expect(body?.error.code).toBe("INTERNAL_ERROR");
	});
	it("signs the MP3_320 copy rather than MP3_MISC (was: orderBy bitrate desc picked MP3_MISC=8 over MP3_320=3)", async () => {
		setSessionUser("u1");
		prismaMock.storedTrack.findMany.mockResolvedValue([
			{ id: "a", trackId: "1", bitrate: 8, storagePath: "tracks/1/8.mp3", storageType: "r2" },
			{ id: "b", trackId: "1", bitrate: 3, storagePath: "tracks/1/3.mp3", storageType: "r2" },
		]);
		getPresignedUrlMock.mockResolvedValue({ url: "https://example.com/3.mp3", contentType: "audio/mpeg" } as never);

		const res = await GET(makeNextRequest(), makeParams({ trackId: "1" }));
		expect(res.status).toBe(200);
		expect(getPresignedUrlMock.mock.calls[0][0]).toBe("tracks/1/3.mp3");
	});

	it("returns not_cached when the only copy is below the listener's licence and server quality (was: an HQ listener got a free account's 128 copy)", async () => {
		setSessionUser("u1");
		serverStateMock.getWaveletApp.mockResolvedValue({ freshSettings: vi.fn(async () => ({ maxBitrate: 3 })) });
		prismaMock.deezerCredential.findUnique.mockResolvedValue({ canStreamHq: true, canStreamLossless: false });
		prismaMock.storedTrack.findMany.mockResolvedValue([
			{ id: "a", trackId: "1", bitrate: 1, requestedBitrate: 1, storagePath: "tracks/1/1.mp3", storageType: "r2" },
		]);

		const res = await GET(makeNextRequest(), makeParams({ trackId: "1" }));
		const body = await readJson<{ data: { url: null; status: string } }>(res);
		expect(body?.data).toEqual({ url: null, status: "not_cached" });
		expect(getPresignedUrlMock).not.toHaveBeenCalled();
	});

	it("never signs a copy above the server quality", async () => {
		setSessionUser("u1");
		serverStateMock.getWaveletApp.mockResolvedValue({ freshSettings: vi.fn(async () => ({ maxBitrate: 1 })) });
		prismaMock.storedTrack.findMany.mockResolvedValue([
			{ id: "a", trackId: "1", bitrate: 9, storagePath: "tracks/1/9.flac", storageType: "r2" },
		]);

		const res = await GET(makeNextRequest(), makeParams({ trackId: "1" }));
		const body = await readJson<{ data: { url: null; status: string } }>(res);
		expect(body?.data.status).toBe("not_cached");
	});
});
