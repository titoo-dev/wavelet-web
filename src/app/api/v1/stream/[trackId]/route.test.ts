import { describe, it, expect, vi, beforeEach } from "vitest";
import { prismaMock, resetPrismaMock } from "@/test/helpers/mockPrisma";
import { authMock, setSessionUser, clearSession } from "@/test/helpers/mockAuth";
import { makeNextRequest, makeParams, readJson } from "@/test/helpers/nextRequest";
import { StorageNotFoundError, StorageUnavailableError } from "@/lib/wavelet/storage/objects";

vi.mock("@/lib/prisma", () => ({ prisma: prismaMock }));
vi.mock("@/lib/auth", () => ({ auth: authMock }));
vi.mock("@/lib/object-stream", () => ({
	streamObject: vi.fn(),
}));
const { serverStateMock } = vi.hoisted(() => ({ serverStateMock: { getWaveletApp: vi.fn() } }));
vi.mock("@/lib/server-state", () => serverStateMock);

import { GET } from "./route";
import { streamObject } from "@/lib/object-stream";

const streamObjectMock = vi.mocked(streamObject);

const blobRow = {
	id: "x",
	trackId: "1",
	bitrate: 320,
	storagePath: "music/foo.mp3",
	storageType: "r2",
};

function fakeBody() {
	return new ReadableStream({
		start(c) {
			c.enqueue(new Uint8Array([1, 2, 3]));
			c.close();
		},
	});
}

describe("GET /api/v1/stream/[trackId]", () => {
	beforeEach(() => {
		resetPrismaMock();
		clearSession();
		streamObjectMock.mockReset();
	});

	it("returns 401 when not authenticated", async () => {
		const res = await GET(makeNextRequest(), makeParams({ trackId: "1" }));
		expect(res.status).toBe(401);
		const body = await readJson<{ error: { code: string } }>(res);
		expect(body?.error.code).toBe("NOT_AUTHENTICATED");
	});

	it("redirects to /stream-progressive when no StoredTrack row exists", async () => {
		setSessionUser("u1");
		prismaMock.storedTrack.findMany.mockResolvedValue([]);

		const res = await GET(makeNextRequest(), makeParams({ trackId: "1" }));
		expect(res.status).toBe(302);
		expect(res.headers.get("Location")).toBe("/api/v1/stream-progressive/1");
		expect(streamObjectMock).not.toHaveBeenCalled();
	});

	it.each(["s3", "local", "blob"])(
		"drops pre-R2 %s rows and 302s to /stream-progressive (was: 400 UNSUPPORTED_STORAGE; blob: unreadable suspended Vercel Blob store)",
		async (storageType) => {
			setSessionUser("u1");
			prismaMock.storedTrack.findMany.mockResolvedValue([{ ...blobRow, storageType }]);

			const res = await GET(makeNextRequest(), makeParams({ trackId: "1" }));
			expect(res.status).toBe(302);
			expect(res.headers.get("Location")).toBe("/api/v1/stream-progressive/1");
			// Only the rows in older storage are dropped (an R2 copy of another
			// bitrate stays usable).
			expect(prismaMock.storedTrack.deleteMany).toHaveBeenCalledWith({
				where: { id: { in: ["x"] } },
			});
			expect(streamObjectMock).not.toHaveBeenCalled();
		}
	);

	it("returns 200 + cache headers when streaming without a Range header", async () => {
		setSessionUser("u1");
		prismaMock.storedTrack.findMany.mockResolvedValue([blobRow]);
		streamObjectMock.mockResolvedValue({
			body: fakeBody(),
			contentLength: 12345,
			contentType: "audio/mpeg",
			statusCode: 200,
		} as never);

		const res = await GET(makeNextRequest(), makeParams({ trackId: "1" }));
		expect(res.status).toBe(200);
		expect(res.headers.get("Content-Type")).toBe("audio/mpeg");
		expect(res.headers.get("Content-Length")).toBe("12345");
		expect(res.headers.get("Accept-Ranges")).toBe("bytes");
		expect(res.headers.get("Cache-Control")).toBe("private, max-age=86400");
		expect(res.headers.get("Content-Range")).toBeNull();
		// No Range was sent — streamObject called without a range.
		expect(streamObjectMock).toHaveBeenCalledWith("music/foo.mp3", undefined);
	});

	it("returns the streamObject statusCode + Content-Range when a Range header is present", async () => {
		setSessionUser("u1");
		prismaMock.storedTrack.findMany.mockResolvedValue([blobRow]);
		streamObjectMock.mockResolvedValue({
			body: fakeBody(),
			contentLength: 100,
			contentRange: "bytes 0-99/12345",
			contentType: "audio/mpeg",
			statusCode: 206,
		});

		const res = await GET(
			makeNextRequest({ headers: { range: "bytes=0-99" } }),
			makeParams({ trackId: "1" })
		);
		expect(res.status).toBe(206);
		expect(res.headers.get("Content-Range")).toBe("bytes 0-99/12345");
		expect(res.headers.get("Accept-Ranges")).toBe("bytes");
		expect(streamObjectMock).toHaveBeenCalledWith("music/foo.mp3", "bytes=0-99");
	});

	it("answers 416 with the size for a range past the end (was: 500 INTERNAL_ERROR)", async () => {
		setSessionUser("u1");
		prismaMock.storedTrack.findMany.mockResolvedValue([blobRow]);
		streamObjectMock.mockResolvedValue({
			body: null,
			contentLength: 0,
			contentRange: "bytes */12345",
			contentType: "audio/mpeg",
			statusCode: 416,
		});

		const res = await GET(
			makeNextRequest({ headers: { range: "bytes=99999-" } }),
			makeParams({ trackId: "1" })
		);
		expect(res.status).toBe(416);
		expect(res.headers.get("Content-Range")).toBe("bytes */12345");
		expect(prismaMock.storedTrack.deleteMany).not.toHaveBeenCalled();
	});

	it("on StorageNotFoundError: deletes the rows of the missing object and 302s to /stream-progressive", async () => {
		setSessionUser("u1");
		prismaMock.storedTrack.findMany.mockResolvedValue([blobRow]);
		streamObjectMock.mockRejectedValue(new StorageNotFoundError("music/foo.mp3"));

		const res = await GET(makeNextRequest(), makeParams({ trackId: "1" }));
		expect(res.status).toBe(302);
		expect(res.headers.get("Location")).toBe("/api/v1/stream-progressive/1");
		// Every row that points at the missing object is stale (legacy keys
		// could be shared); copies at other keys stay.
		expect(prismaMock.storedTrack.deleteMany).toHaveBeenCalledWith({
			where: { storagePath: "music/foo.mp3" },
		});
	});

	it("still 302s when the stale-row cleanup itself fails", async () => {
		setSessionUser("u1");
		prismaMock.storedTrack.findMany.mockResolvedValue([blobRow]);
		prismaMock.storedTrack.deleteMany.mockRejectedValue(new Error("db down"));
		streamObjectMock.mockRejectedValue(new StorageNotFoundError("music/foo.mp3"));

		const res = await GET(makeNextRequest(), makeParams({ trackId: "1" }));
		expect(res.status).toBe(302);
		expect(res.headers.get("Location")).toBe("/api/v1/stream-progressive/1");
	});

	it("on StorageUnavailableError: 302 to a live-only /stream-progressive WITHOUT deleting the row (was: progressive's head() passed on the suspended store and bounced back here — 500 'Your store is blocked')", async () => {
		setSessionUser("u1");
		prismaMock.storedTrack.findMany.mockResolvedValue([blobRow]);
		streamObjectMock.mockRejectedValue(new StorageUnavailableError(new Error("403")));

		const res = await GET(makeNextRequest(), makeParams({ trackId: "1" }));
		expect(res.status).toBe(302);
		expect(res.headers.get("Location")).toBe("/api/v1/stream-progressive/1?live=1");
		expect(prismaMock.storedTrack.deleteMany).not.toHaveBeenCalled();
	});

	it("on a generic error: falls through to handleError (500 INTERNAL_ERROR)", async () => {
		setSessionUser("u1");
		prismaMock.storedTrack.findMany.mockResolvedValue([blobRow]);
		streamObjectMock.mockRejectedValue(new Error("kaboom"));

		const res = await GET(makeNextRequest(), makeParams({ trackId: "1" }));
		expect(res.status).toBe(500);
		const body = await readJson<{ error: { code: string } }>(res);
		expect(body?.error.code).toBe("INTERNAL_ERROR");
		expect(prismaMock.storedTrack.deleteMany).not.toHaveBeenCalled();
	});
	it("serves the MP3_320 copy rather than MP3_MISC (was: orderBy bitrate desc picked MP3_MISC=8 over MP3_320=3)", async () => {
		setSessionUser("u1");
		prismaMock.storedTrack.findMany.mockResolvedValue([
			{ ...blobRow, id: "misc", bitrate: 8, storagePath: "tracks/1/8.mp3" },
			{ ...blobRow, id: "hq", bitrate: 3, storagePath: "tracks/1/3.mp3" },
		]);
		streamObjectMock.mockResolvedValue({ body: fakeBody(), contentLength: 3, contentType: "audio/mpeg", statusCode: 200 } as never);

		const res = await GET(makeNextRequest(), makeParams({ trackId: "1" }));
		expect(res.status).toBe(200);
		expect(streamObjectMock).toHaveBeenCalledWith("tracks/1/3.mp3", undefined);
	});

	it("sends an HQ listener with only a 128 copy to an upgrading live play (was: served the free account's 128 copy forever)", async () => {
		setSessionUser("u1");
		serverStateMock.getWaveletApp.mockResolvedValue({ freshSettings: vi.fn(async () => ({ maxBitrate: 3 })) });
		prismaMock.deezerCredential.findUnique.mockResolvedValue({ canStreamHq: true, canStreamLossless: false });
		prismaMock.storedTrack.findMany.mockResolvedValue([{ ...blobRow, bitrate: 1, requestedBitrate: 1 }]);

		const res = await GET(makeNextRequest(), makeParams({ trackId: "1" }));
		expect(res.status).toBe(302);
		// live=1: the progressive route re-persists without its own cache check,
		// so a stale quality setting on another instance cannot bounce back here.
		expect(res.headers.get("Location")).toBe("/api/v1/stream-progressive/1?live=1");
		expect(streamObjectMock).not.toHaveBeenCalled();
	});

	it("sends a track cached only above this instance's quality to a live=1 play (was: /stream <-> /stream-progressive redirect loop while instances disagreed on the quality setting)", async () => {
		setSessionUser("u1");
		// This instance already reads Medium; another one still caches High and
		// sends the FLAC copy here as a hit.
		serverStateMock.getWaveletApp.mockResolvedValue({ freshSettings: vi.fn(async () => ({ maxBitrate: 3 })) });
		prismaMock.storedTrack.findMany.mockResolvedValue([{ ...blobRow, bitrate: 9, storagePath: "tracks/1/9.flac" }]);

		const res = await GET(makeNextRequest(), makeParams({ trackId: "1" }));
		expect(res.status).toBe(302);
		expect(res.headers.get("Location")).toBe("/api/v1/stream-progressive/1?live=1");
		expect(streamObjectMock).not.toHaveBeenCalled();
	});

	it("serves a 128 copy that was persisted for a 320 request (Deezer had no 320)", async () => {
		setSessionUser("u1");
		serverStateMock.getWaveletApp.mockResolvedValue({ freshSettings: vi.fn(async () => ({ maxBitrate: 3 })) });
		prismaMock.deezerCredential.findUnique.mockResolvedValue({ canStreamHq: true, canStreamLossless: false });
		prismaMock.storedTrack.findMany.mockResolvedValue([{ ...blobRow, bitrate: 1, requestedBitrate: 3 }]);
		streamObjectMock.mockResolvedValue({ body: fakeBody(), contentLength: 3, contentType: "audio/mpeg", statusCode: 200 } as never);

		const res = await GET(makeNextRequest(), makeParams({ trackId: "1" }));
		expect(res.status).toBe(200);
	});

	describe("?prefetch=1 (C5)", () => {
		const prefetch = () => makeNextRequest({ url: "http://localhost:3000/api/v1/stream/1?prefetch=1" });

		it("answers 404 NOT_CACHED instead of the 302 to a live Deezer stream (was: prefetch started a live download)", async () => {
			setSessionUser("u1");
			prismaMock.storedTrack.findMany.mockResolvedValue([]);

			const res = await GET(prefetch(), makeParams({ trackId: "1" }));
			expect(res.status).toBe(404);
			const body = await readJson<{ success: boolean; error: { code: string } }>(res);
			expect(body).toMatchObject({ success: false, error: { code: "NOT_CACHED" } });
		});

		it("answers 404 NOT_CACHED when the copy needs an upgrade, is in older storage or is missing", async () => {
			setSessionUser("u1");
			serverStateMock.getWaveletApp.mockResolvedValue({ freshSettings: vi.fn(async () => ({ maxBitrate: 3 })) });
			prismaMock.deezerCredential.findUnique.mockResolvedValue({ canStreamHq: true, canStreamLossless: false });
			prismaMock.storedTrack.findMany.mockResolvedValue([{ ...blobRow, bitrate: 1, requestedBitrate: 1 }]);
			expect((await GET(prefetch(), makeParams({ trackId: "1" }))).status).toBe(404);

			prismaMock.storedTrack.findMany.mockResolvedValue([{ ...blobRow, storageType: "blob" }]);
			expect((await GET(prefetch(), makeParams({ trackId: "1" }))).status).toBe(404);

			prismaMock.storedTrack.findMany.mockResolvedValue([blobRow]);
			streamObjectMock.mockRejectedValue(new StorageNotFoundError("music/foo.mp3"));
			expect((await GET(prefetch(), makeParams({ trackId: "1" }))).status).toBe(404);

			streamObjectMock.mockRejectedValue(new StorageUnavailableError(new Error("503")));
			const res = await GET(prefetch(), makeParams({ trackId: "1" }));
			expect(res.status).toBe(404);
			expect(res.headers.get("Location")).toBeNull();
		});

		it("streams a cached copy as usual", async () => {
			setSessionUser("u1");
			prismaMock.storedTrack.findMany.mockResolvedValue([blobRow]);
			streamObjectMock.mockResolvedValue({ body: fakeBody(), contentLength: 3, contentType: "audio/mpeg", statusCode: 200 } as never);

			const res = await GET(prefetch(), makeParams({ trackId: "1" }));
			expect(res.status).toBe(200);
		});
	});
});
