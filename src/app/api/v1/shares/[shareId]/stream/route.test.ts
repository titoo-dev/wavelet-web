import { describe, it, expect, vi, beforeEach } from "vitest";
import { prismaMock, resetPrismaMock } from "@/test/helpers/mockPrisma";
import { makeNextRequest, makeParams, readJson } from "@/test/helpers/nextRequest";
import { StorageNotFoundError, StorageUnavailableError } from "@/lib/wavelet/storage/objects";
import { UpstreamHttpError } from "@/lib/wavelet/stream-errors";

const { afterMock, streamObjectMock, startProgressiveStreamMock, followMock, serverStateMock } = vi.hoisted(() => ({
	afterMock: vi.fn(),
	streamObjectMock: vi.fn(),
	startProgressiveStreamMock: vi.fn(),
	followMock: vi.fn(),
	serverStateMock: { getWaveletApp: vi.fn(), getOrLoginUserDz: vi.fn() },
}));

vi.mock("@/lib/prisma", () => ({ prisma: prismaMock }));
vi.mock("next/server", async (importOriginal) => ({
	...(await importOriginal<typeof import("next/server")>()),
	after: afterMock,
}));
vi.mock("@/lib/object-stream", () => ({ streamObject: streamObjectMock }));
vi.mock("@/lib/wavelet/progressive-stream", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/wavelet/progressive-stream")>()),
	startProgressiveStream: startProgressiveStreamMock,
	followProgressiveStream: followMock,
}));
vi.mock("@/lib/server-state", () => serverStateMock);

import { GET } from "./route";

/** Was "public, max-age=3600": a revoked link kept playing from cache for an hour. */
const SHARE_CACHE_CONTROL = "private, no-cache";

function fakeBody() {
	return new ReadableStream({
		start(c) {
			c.enqueue(new Uint8Array([1]));
			c.close();
		},
	});
}

function share(storedTrackId: string | null = null) {
	return {
		id: "s1",
		shareId: "abc",
		trackId: "42",
		userId: "owner",
		expiresAt: null,
		storedTrackId,
	};
}

const blobStored = { id: "st1", trackId: "42", bitrate: 1, storagePath: "music/x.mp3", storageType: "r2" };

let ip = 0;
/** Each test gets its own client address so the per-IP fallback quota never leaks between tests. */
function request(headers: Record<string, string> = {}) {
	return makeNextRequest({ headers: { "x-forwarded-for": `10.0.0.${++ip}`, ...headers } });
}

function makeLock(opts: { alreadyInProgress?: boolean; shared?: unknown } = {}) {
	return {
		alreadyInProgress: opts.alreadyInProgress ?? false,
		waitForExisting: vi.fn(),
		follow: vi.fn(async () => opts.shared ?? null),
		publish: vi.fn(),
		release: vi.fn(),
	};
}

function arrangeProgressive(lock = makeLock()) {
	const persisted = Promise.resolve();
	serverStateMock.getOrLoginUserDz.mockResolvedValue({ loggedIn: true });
	serverStateMock.getWaveletApp.mockResolvedValue({
		settings: { maxBitrate: 1 },
		// The config store now holds High: the share must follow it, not the cold-start value.
		freshSettings: vi.fn(async () => ({ maxBitrate: 3 })),
		storageProvider: {},
		acquireDownloadLock: vi.fn(() => lock),
	});
	startProgressiveStreamMock.mockResolvedValue({
		body: fakeBody(),
		contentType: "audio/mpeg",
		contentLength: 0,
		totalLength: null,
		start: 0,
		end: null,
		rangeSupported: false,
		persisted,
	});
	return persisted;
}

describe("GET /api/v1/shares/[shareId]/stream", () => {
	beforeEach(() => {
		resetPrismaMock();
		vi.resetAllMocks();
		prismaMock.sharedTrack.update.mockResolvedValue({});
		prismaMock.storedTrack.findMany.mockResolvedValue([]);
	});

	it("serves a cached share through the proxy with its range", async () => {
		prismaMock.sharedTrack.findUnique.mockResolvedValue(share("st1"));
		prismaMock.storedTrack.findMany.mockResolvedValue([blobStored]);
		streamObjectMock.mockResolvedValue({
			body: fakeBody(),
			contentLength: 10,
			contentRange: "bytes 0-9/100",
			contentType: "audio/mpeg",
			statusCode: 206,
		});

		const res = await GET(request({ range: "bytes=0-9" }), makeParams({ shareId: "abc" }));
		expect(res.status).toBe(206);
		expect(res.headers.get("Content-Range")).toBe("bytes 0-9/100");
		expect(streamObjectMock).toHaveBeenCalledWith("music/x.mp3", "bytes=0-9");
		// Revoking or expiring the link must stop playback: nothing kept in a shared or browser cache.
		expect(res.headers.get("Cache-Control")).toBe(SHARE_CACHE_CONTROL);
		expect(startProgressiveStreamMock).not.toHaveBeenCalled();
	});

	it("answers 416 from the cached copy for a range past the end (was: fell through to a Deezer re-download)", async () => {
		prismaMock.sharedTrack.findUnique.mockResolvedValue(share("st1"));
		prismaMock.storedTrack.findMany.mockResolvedValue([blobStored]);
		streamObjectMock.mockResolvedValue({
			body: null,
			contentLength: 0,
			contentRange: "bytes */100",
			contentType: "audio/mpeg",
			statusCode: 416,
		});

		const res = await GET(request({ range: "bytes=500-" }), makeParams({ shareId: "abc" }));
		expect(res.status).toBe(416);
		expect(res.headers.get("Content-Range")).toBe("bytes */100");
		expect(startProgressiveStreamMock).not.toHaveBeenCalled();
		expect(prismaMock.sharedTrack.update).not.toHaveBeenCalledWith(
			expect.objectContaining({ data: { plays: { increment: 1 } } })
		);
	});

	it("plays the copy persisted after the share was created and re-links it (was: share.storedTrack stayed null, so every visit re-downloaded from Deezer forever)", async () => {
		prismaMock.sharedTrack.findUnique.mockResolvedValue(share(null));
		prismaMock.storedTrack.findMany.mockResolvedValue([blobStored]);
		streamObjectMock.mockResolvedValue({ body: fakeBody(), contentLength: 1, contentType: "audio/mpeg", statusCode: 200 });

		const res = await GET(request(), makeParams({ shareId: "abc" }));
		expect(res.status).toBe(200);
		expect(streamObjectMock).toHaveBeenCalledWith("music/x.mp3", undefined);
		expect(prismaMock.sharedTrack.update).toHaveBeenCalledWith({ where: { id: "s1" }, data: { storedTrackId: "st1" } });
		expect(startProgressiveStreamMock).not.toHaveBeenCalled();
		expect(serverStateMock.getOrLoginUserDz).not.toHaveBeenCalled();
	});

	it("re-streams pre-R2 shares via progressive without touching storage", async () => {
		prismaMock.sharedTrack.findUnique.mockResolvedValue(share("old"));
		prismaMock.storedTrack.findMany.mockResolvedValue([{ ...blobStored, id: "old", storageType: "s3" }]);
		arrangeProgressive();

		const res = await GET(request(), makeParams({ shareId: "abc" }));
		expect(res.status).toBe(200);
		expect(streamObjectMock).not.toHaveBeenCalled();
		expect(startProgressiveStreamMock).toHaveBeenCalledWith(
			expect.objectContaining({ trackId: "42", userId: "owner" })
		);
	});

	it("detaches a missing object and falls back to progressive", async () => {
		prismaMock.sharedTrack.findUnique.mockResolvedValue(share("st1"));
		prismaMock.storedTrack.findMany.mockResolvedValue([blobStored]);
		streamObjectMock.mockRejectedValue(new StorageNotFoundError("music/x.mp3"));
		arrangeProgressive();

		const res = await GET(request(), makeParams({ shareId: "abc" }));
		expect(res.status).toBe(200);
		expect(prismaMock.storedTrack.deleteMany).toHaveBeenCalledWith({ where: { storagePath: "music/x.mp3" } });
		expect(prismaMock.sharedTrack.update).toHaveBeenCalledWith({
			where: { id: "s1" },
			data: { storedTrackId: null },
		});
	});

	it("falls back to progressive without dropping the copy when storage is unavailable", async () => {
		prismaMock.sharedTrack.findUnique.mockResolvedValue(share("st1"));
		prismaMock.storedTrack.findMany.mockResolvedValue([blobStored]);
		streamObjectMock.mockRejectedValue(new StorageUnavailableError(new Error("503")));
		arrangeProgressive();

		const res = await GET(request(), makeParams({ shareId: "abc" }));
		expect(res.status).toBe(200);
		expect(prismaMock.storedTrack.deleteMany).not.toHaveBeenCalled();
	});

	it("re-streams at the server quality saved since this instance started (was: kept the cold-start maxBitrate)", async () => {
		prismaMock.sharedTrack.findUnique.mockResolvedValue(share(null));
		arrangeProgressive();

		await GET(request(), makeParams({ shareId: "abc" }));
		expect(startProgressiveStreamMock).toHaveBeenCalledWith(
			expect.objectContaining({ bitrate: 3, settings: expect.objectContaining({ maxBitrate: 3 }) })
		);
	});

	it("hands the progressive persist promise to after() (was: fire-and-forget)", async () => {
		prismaMock.sharedTrack.findUnique.mockResolvedValue(share(null));
		const persisted = arrangeProgressive();

		await GET(request(), makeParams({ shareId: "abc" }));
		// [0] = play counter, [1] = persist pipeline
		expect(afterMock).toHaveBeenCalledTimes(2);
		const persistCallback = afterMock.mock.calls[1][0] as () => unknown;
		expect(persistCallback()).toBe(persisted);
	});

	it("persists under the lock and the lease like /stream-progressive (was: no lock — concurrent visitors each downloaded the track)", async () => {
		prismaMock.sharedTrack.findUnique.mockResolvedValue(share(null));
		const lock = makeLock();
		arrangeProgressive(lock);

		await GET(request(), makeParams({ shareId: "abc" }));
		expect(prismaMock.persistLease.create).toHaveBeenCalledWith({ data: expect.objectContaining({ trackId: "42", bitrate: 3 }) });
		expect(startProgressiveStreamMock).toHaveBeenCalledWith(
			expect.objectContaining({ persist: true, lock: { release: lock.release, publish: lock.publish } })
		);
	});

	it("lets a concurrent visitor on the same instance follow the in-progress download", async () => {
		prismaMock.sharedTrack.findUnique.mockResolvedValue(share(null));
		const shared = { spool: {} };
		arrangeProgressive(makeLock({ alreadyInProgress: true, shared }));
		followMock.mockReturnValue({ body: fakeBody(), contentType: "audio/mpeg", contentLength: 1, totalLength: 1, start: 0, end: 0, rangeSupported: true, persisted: Promise.resolve() });

		const res = await GET(request(), makeParams({ shareId: "abc" }));
		expect(res.status).toBe(200);
		expect(res.headers.get("Cache-Control")).toBe(SHARE_CACHE_CONTROL);
		expect(followMock).toHaveBeenCalledWith(shared);
		expect(startProgressiveStreamMock).not.toHaveBeenCalled();
	});

	it("serves a seek on the Deezer fallback as a live range", async () => {
		prismaMock.sharedTrack.findUnique.mockResolvedValue(share(null));
		arrangeProgressive();
		startProgressiveStreamMock.mockResolvedValue({ body: fakeBody(), contentType: "audio/mpeg", contentLength: 100, totalLength: 1000, start: 100, end: 199, rangeSupported: true, persisted: Promise.resolve() });

		const res = await GET(request({ range: "bytes=100-199" }), makeParams({ shareId: "abc" }));
		expect(res.status).toBe(206);
		expect(res.headers.get("Content-Range")).toBe("bytes 100-199/1000");
		expect(startProgressiveStreamMock).toHaveBeenCalledWith(expect.objectContaining({ persist: false, range: { start: 100, end: 199 } }));
	});

	it("counts a play only for the first request of a listen (was: plays++ on every Range request)", async () => {
		prismaMock.sharedTrack.findUnique.mockResolvedValue(share("st1"));
		prismaMock.storedTrack.findMany.mockResolvedValue([blobStored]);
		streamObjectMock.mockImplementation(async () => ({ body: fakeBody(), contentLength: 1, contentType: "audio/mpeg", statusCode: 206 }));

		await GET(request({ range: "bytes=500-" }), makeParams({ shareId: "abc" }));
		await GET(request({ range: "bytes=0-1" }), makeParams({ shareId: "abc" }));
		expect(afterMock).not.toHaveBeenCalled();

		await GET(request({ range: "bytes=0-" }), makeParams({ shareId: "abc" }));
		await GET(request(), makeParams({ shareId: "abc" }));
		expect(afterMock).toHaveBeenCalledTimes(2);
		(afterMock.mock.calls[0][0] as () => void)();
		expect(prismaMock.sharedTrack.update).toHaveBeenCalledWith({ where: { shareId: "abc" }, data: { plays: { increment: 1 } } });
	});

	it("counts a Safari / AVPlayer listen once (was: its bytes=0-1 probe and bytes=0-n play were never counted)", async () => {
		prismaMock.sharedTrack.findUnique.mockResolvedValue(share("st1"));
		prismaMock.storedTrack.findMany.mockResolvedValue([blobStored]);
		streamObjectMock.mockImplementation(async () => ({ body: fakeBody(), contentLength: 1, contentType: "audio/mpeg", statusCode: 206 }));

		await GET(request({ range: "bytes=0-1" }), makeParams({ shareId: "abc" }));
		await GET(request({ range: "bytes=0-3623704" }), makeParams({ shareId: "abc" }));
		await GET(request({ range: "bytes=1800000-3623704" }), makeParams({ shareId: "abc" }));
		for (const [cb] of afterMock.mock.calls) (cb as () => void)();
		expect(prismaMock.sharedTrack.update).toHaveBeenCalledTimes(1);
		expect(prismaMock.sharedTrack.update).toHaveBeenCalledWith({ where: { shareId: "abc" }, data: { plays: { increment: 1 } } });
	});

	it("does not count a request that was refused or failed (was: plays++ before the 429 / 410 / 422 answer)", async () => {
		prismaMock.sharedTrack.findUnique.mockResolvedValue(share(null));
		arrangeProgressive();
		startProgressiveStreamMock.mockRejectedValue(new UpstreamHttpError(404));
		expect((await GET(request(), makeParams({ shareId: "abc" }))).status).toBe(422);

		serverStateMock.getOrLoginUserDz.mockResolvedValue(null);
		expect((await GET(request(), makeParams({ shareId: "abc" }))).status).toBe(410);

		const same = { "x-forwarded-for": "203.0.113.77" };
		serverStateMock.getOrLoginUserDz.mockResolvedValue({ loggedIn: true });
		startProgressiveStreamMock.mockResolvedValue({ body: fakeBody(), contentType: "audio/mpeg", contentLength: 0, totalLength: null, start: 0, end: null, rangeSupported: false, persisted: Promise.resolve() });
		for (let i = 0; i < 30; i++) await GET(makeNextRequest({ headers: same }), makeParams({ shareId: "abc" }));
		prismaMock.sharedTrack.update.mockClear();
		afterMock.mockClear();
		expect((await GET(makeNextRequest({ headers: same }), makeParams({ shareId: "abc" }))).status).toBe(429);

		for (const [cb] of afterMock.mock.calls) await (cb as () => unknown)();
		expect(prismaMock.sharedTrack.update).not.toHaveBeenCalled();
	});

	it("rate-limits the Deezer fallback per client address (was: every visitor re-streamed with the owner's account, unlimited)", async () => {
		prismaMock.sharedTrack.findUnique.mockResolvedValue(share(null));
		arrangeProgressive();
		const same = { "x-forwarded-for": "203.0.113.9" };

		for (let i = 0; i < 30; i++) {
			const ok = await GET(makeNextRequest({ headers: same }), makeParams({ shareId: "abc" }));
			expect(ok.status).toBe(200);
		}
		const limited = await GET(makeNextRequest({ headers: same }), makeParams({ shareId: "abc" }));
		expect(limited.status).toBe(429);
		expect(Number(limited.headers.get("Retry-After"))).toBeGreaterThan(0);
		expect(await readJson(limited)).toMatchObject({ error: { code: "RATE_LIMITED" } });

		const other = await GET(request(), makeParams({ shareId: "abc" }));
		expect(other.status).toBe(200);
	});

	it("does not rate-limit cached plays", async () => {
		prismaMock.sharedTrack.findUnique.mockResolvedValue(share("st1"));
		prismaMock.storedTrack.findMany.mockResolvedValue([blobStored]);
		streamObjectMock.mockImplementation(async () => ({ body: fakeBody(), contentLength: 1, contentType: "audio/mpeg", statusCode: 200 }));
		const same = { "x-forwarded-for": "203.0.113.10" };

		for (let i = 0; i < 35; i++) {
			expect((await GET(makeNextRequest({ headers: same }), makeParams({ shareId: "abc" }))).status).toBe(200);
		}
	});

	it("answers 404, 410 for unknown and expired shares", async () => {
		prismaMock.sharedTrack.findUnique.mockResolvedValue(null);
		expect((await GET(request(), makeParams({ shareId: "nope" }))).status).toBe(404);
		prismaMock.sharedTrack.findUnique.mockResolvedValue({ ...share(null), expiresAt: new Date(Date.now() - 1000) });
		expect((await GET(request(), makeParams({ shareId: "abc" }))).status).toBe(410);
	});

	it("answers 410 SHARE_OWNER_OFFLINE and 500 STORAGE_UNAVAILABLE on the fallback", async () => {
		prismaMock.sharedTrack.findUnique.mockResolvedValue(share(null));
		serverStateMock.getOrLoginUserDz.mockResolvedValue(null);
		const offline = await GET(request(), makeParams({ shareId: "abc" }));
		expect(offline.status).toBe(410);
		expect(await readJson(offline)).toMatchObject({ error: { code: "SHARE_OWNER_OFFLINE" } });

		serverStateMock.getOrLoginUserDz.mockResolvedValue({ loggedIn: true });
		serverStateMock.getWaveletApp.mockResolvedValue({ storageProvider: null });
		expect((await GET(request(), makeParams({ shareId: "abc" }))).status).toBe(500);
	});

	it("maps Deezer failures (422 / 502) and hides other errors behind a generic 500", async () => {
		prismaMock.sharedTrack.findUnique.mockResolvedValue(share(null));
		arrangeProgressive();
		startProgressiveStreamMock.mockRejectedValue(new UpstreamHttpError(404));
		expect((await GET(request(), makeParams({ shareId: "abc" }))).status).toBe(422);

		startProgressiveStreamMock.mockRejectedValue(new Error("secret detail"));
		const res = await GET(request(), makeParams({ shareId: "abc" }));
		expect(res.status).toBe(500);
		expect(await readJson(res)).toEqual({ success: false, error: { code: "INTERNAL_ERROR", message: "An unexpected error occurred." } });
	});
});
