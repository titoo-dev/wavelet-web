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
import {
	StorageNotFoundError,
	StorageUnavailableError,
} from "@/lib/wavelet/storage/objects";
import {
	RangeNotSatisfiableError,
	RangeNotSupportedError,
	UpstreamHttpError,
	UpstreamTimeoutError,
} from "@/lib/wavelet/stream-errors";

// ── Mock setup ──

vi.mock("@/lib/prisma", () => ({ prisma: prismaMock }));
vi.mock("@/lib/auth", () => ({ auth: authMock }));

// vi.mock factories are hoisted above imports — use vi.hoisted() so test
// code can share refs with the factory below.
const { serverStateMock, blobStreamMock, startProgressiveStreamMock, followMock, probeMock, afterMock } = vi.hoisted(
	() => ({
		serverStateMock: {
			getWaveletApp: vi.fn(),
			getUserDz: vi.fn(),
			setUserDz: vi.fn(),
			getGuestDz: vi.fn(),
		},
		blobStreamMock: {
			headObject: vi.fn(),
		},
		startProgressiveStreamMock: vi.fn(),
		followMock: vi.fn(),
		probeMock: vi.fn(),
		afterMock: vi.fn(),
	})
);

// after() throws outside a real request scope — capture the callbacks instead.
vi.mock("next/server", async (importOriginal) => ({
	...(await importOriginal<typeof import("next/server")>()),
	after: afterMock,
}));

vi.mock("@/lib/server-state", () => serverStateMock);
vi.mock("@/lib/object-stream", () => blobStreamMock);
vi.mock("@/lib/wavelet/progressive-stream", async (importOriginal) => ({
	// classifyStreamError stays real (pure error → HTTP mapping).
	...(await importOriginal<typeof import("@/lib/wavelet/progressive-stream")>()),
	startProgressiveStream: startProgressiveStreamMock,
	followProgressiveStream: followMock,
	probeProgressiveStream: probeMock,
}));

import { GET } from "./route";

// ── Local helpers / factories (kept inline per test guidance) ──

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

interface FakeLock {
	alreadyInProgress: boolean;
	waitForExisting: ReturnType<typeof vi.fn>;
	follow: ReturnType<typeof vi.fn>;
	publish: ReturnType<typeof vi.fn>;
	release: ReturnType<typeof vi.fn>;
}

interface FakeAppOptions {
	storageProvider?: unknown;
	lockAlreadyInProgress?: boolean;
	/** What a same-instance holder published (C4). */
	shared?: unknown;
	maxBitrate?: number;
	/** What the config store holds now (another instance may have changed it). */
	savedBitrate?: number;
}

function makeApp(opts: FakeAppOptions = {}) {
	const lock: FakeLock = {
		alreadyInProgress: opts.lockAlreadyInProgress ?? false,
		waitForExisting: vi.fn(async () => {}),
		follow: vi.fn(async () => opts.shared ?? null),
		publish: vi.fn(),
		release: vi.fn(),
	};
	const acquireDownloadLock = vi.fn(() => lock);
	const settings = { maxBitrate: opts.maxBitrate ?? 320 };
	const app = {
		settings,
		freshSettings: vi.fn(async () => (opts.savedBitrate != null ? { ...settings, maxBitrate: opts.savedBitrate } : settings)),
		acquireDownloadLock,
		storageProvider:
			opts.storageProvider === undefined ? {} : opts.storageProvider,
	};
	return { app, lock, acquireDownloadLock };
}

/** Configure the auth + Deezer + WaveletApp mocks for a successful guard. */
function arrangeAuthOk(app: unknown) {
	setSessionUser("u1");
	serverStateMock.getUserDz.mockReturnValue({ loggedIn: true });
	serverStateMock.getWaveletApp.mockResolvedValue(app);
}

describe("GET /api/v1/stream-progressive/[trackId]", () => {
	beforeEach(() => {
		resetPrismaMock();
		clearSession();
		serverStateMock.getWaveletApp.mockReset();
		serverStateMock.getUserDz.mockReset();
		serverStateMock.setUserDz.mockReset();
		serverStateMock.getGuestDz.mockReset();
		blobStreamMock.headObject.mockReset();
		startProgressiveStreamMock.mockReset();
		followMock.mockReset();
		probeMock.mockReset();
		afterMock.mockReset();
	});

	it("returns 401 NOT_AUTHENTICATED when there is no session", async () => {
		// No session, no Deezer ARL → guard fails before any work happens.
		const res = await GET(
			makeNextRequest({
				url: "http://localhost:3000/api/v1/stream-progressive/1",
			}),
			makeParams({ trackId: "1" })
		);
		expect(res.status).toBe(401);
		const body = await readJson<{ error: { code: string } }>(res);
		expect(body?.error.code).toBe("NOT_AUTHENTICATED");
		expect(startProgressiveStreamMock).not.toHaveBeenCalled();
	});

	it("returns 403 NO_DEEZER_ARL when user is signed in but has no Deezer credential", async () => {
		setSessionUser("u1");
		serverStateMock.getUserDz.mockReturnValue(null);
		prismaMock.deezerCredential.findUnique.mockResolvedValue(null);

		const res = await GET(
			makeNextRequest({
				url: "http://localhost:3000/api/v1/stream-progressive/1",
			}),
			makeParams({ trackId: "1" })
		);
		expect(res.status).toBe(403);
		const body = await readJson<{ error: { code: string } }>(res);
		expect(body?.error.code).toBe("NO_DEEZER_ARL");
	});

	it("redirects to /stream when stored row exists in Blob and headObject succeeds", async () => {
		const { app, acquireDownloadLock } = makeApp();
		arrangeAuthOk(app);
		prismaMock.storedTrack.findMany.mockResolvedValue([blobRow]);
		blobStreamMock.headObject.mockResolvedValue({
			contentLength: 100,
			contentType: "audio/mpeg",
		});

		const res = await GET(
			makeNextRequest({
				url: "http://localhost:3000/api/v1/stream-progressive/1",
			}),
			makeParams({ trackId: "1" })
		);
		expect(res.status).toBe(302);
		expect(res.headers.get("Location")).toBe("/api/v1/stream/1");
		expect(blobStreamMock.headObject).toHaveBeenCalledWith("music/foo.mp3");
		expect(acquireDownloadLock).not.toHaveBeenCalled();
		expect(startProgressiveStreamMock).not.toHaveBeenCalled();
	});

	it("on headObject StorageNotFoundError: deletes the rows of the missing object and falls through to live stream", async () => {
		const { app } = makeApp();
		arrangeAuthOk(app);
		prismaMock.storedTrack.findMany.mockResolvedValue([blobRow]);
		blobStreamMock.headObject.mockRejectedValue(new StorageNotFoundError("music/foo.mp3"));
		startProgressiveStreamMock.mockResolvedValue({
			body: fakeBody(),
			contentType: "audio/mpeg",
			contentLength: 0,
		});

		const res = await GET(
			makeNextRequest({
				url: "http://localhost:3000/api/v1/stream-progressive/1",
			}),
			makeParams({ trackId: "1" })
		);
		expect(res.status).toBe(200);
		// Every row pointing at the missing object; copies at other keys stay.
		expect(prismaMock.storedTrack.deleteMany).toHaveBeenCalledWith({
			where: { storagePath: "music/foo.mp3" },
		});
		expect(startProgressiveStreamMock).toHaveBeenCalled();
	});

	it("on headObject StorageUnavailableError: falls through to live stream WITHOUT deleting the row", async () => {
		const { app } = makeApp();
		arrangeAuthOk(app);
		prismaMock.storedTrack.findMany.mockResolvedValue([blobRow]);
		blobStreamMock.headObject.mockRejectedValue(new StorageUnavailableError(new Error("503")));
		startProgressiveStreamMock.mockResolvedValue({
			body: fakeBody(),
			contentType: "audio/mpeg",
			contentLength: 0,
		});

		const res = await GET(
			makeNextRequest({
				url: "http://localhost:3000/api/v1/stream-progressive/1",
			}),
			makeParams({ trackId: "1" })
		);
		expect(res.status).toBe(200);
		expect(prismaMock.storedTrack.deleteMany).not.toHaveBeenCalled();
		expect(startProgressiveStreamMock).toHaveBeenCalled();
	});

	it("with live=1 streams from Deezer without touching the cache (was: /stream ↔ /stream-progressive redirect loop while storage refused reads)", async () => {
		const { app } = makeApp();
		arrangeAuthOk(app);
		prismaMock.storedTrack.findMany.mockResolvedValue([blobRow]);
		blobStreamMock.headObject.mockResolvedValue({ contentLength: 1, contentType: "audio/mpeg" });
		startProgressiveStreamMock.mockResolvedValue({
			body: fakeBody(),
			contentType: "audio/mpeg",
			contentLength: 0,
		});

		const res = await GET(
			makeNextRequest({
				url: "http://localhost:3000/api/v1/stream-progressive/1?live=1",
			}),
			makeParams({ trackId: "1" })
		);
		expect(res.status).toBe(200);
		expect(blobStreamMock.headObject).not.toHaveBeenCalled();
		expect(prismaMock.storedTrack.deleteMany).not.toHaveBeenCalled();
		expect(startProgressiveStreamMock).toHaveBeenCalled();
	});

	it.each(["s3", "local", "blob"])(
		"drops pre-R2 %s rows and streams live (was: 302 to /stream for local rows; blob: unreadable suspended Vercel Blob store)",
		async (storageType) => {
			const { app } = makeApp();
			arrangeAuthOk(app);
			prismaMock.storedTrack.findMany.mockResolvedValue([{ ...blobRow, storageType }]);
			startProgressiveStreamMock.mockResolvedValue({
				body: fakeBody(),
				contentType: "audio/mpeg",
				contentLength: 0,
			});

			const res = await GET(
				makeNextRequest({
					url: "http://localhost:3000/api/v1/stream-progressive/1",
				}),
				makeParams({ trackId: "1" })
			);
			expect(res.status).toBe(200);
			expect(blobStreamMock.headObject).not.toHaveBeenCalled();
			// Only the rows in older storage are dropped.
			expect(prismaMock.storedTrack.deleteMany).toHaveBeenCalledWith({
				where: { id: { in: ["x"] } },
			});
			expect(startProgressiveStreamMock).toHaveBeenCalled();
		}
	);

	it("hands the persist promise to after() so Vercel doesn't freeze the upload (was: fire-and-forget)", async () => {
		const { app } = makeApp();
		arrangeAuthOk(app);
		prismaMock.storedTrack.findMany.mockResolvedValue([]);
		const persisted = Promise.resolve();
		startProgressiveStreamMock.mockResolvedValue({
			body: fakeBody(),
			contentType: "audio/mpeg",
			contentLength: 0,
			persisted,
		});

		const res = await GET(
			makeNextRequest({
				url: "http://localhost:3000/api/v1/stream-progressive/1",
			}),
			makeParams({ trackId: "1" })
		);
		expect(res.status).toBe(200);
		expect(afterMock).toHaveBeenCalledTimes(1);
		const callback = afterMock.mock.calls[0][0] as () => unknown;
		expect(callback()).toBe(persisted);
	});

	it("opens a live stream when no stored row exists", async () => {
		const { app, acquireDownloadLock } = makeApp();
		arrangeAuthOk(app);
		prismaMock.storedTrack.findMany.mockResolvedValue([]);
		startProgressiveStreamMock.mockResolvedValue({
			body: fakeBody(),
			contentType: "audio/mpeg",
			contentLength: 9001,
		});

		const res = await GET(
			makeNextRequest({
				url: "http://localhost:3000/api/v1/stream-progressive/1",
			}),
			makeParams({ trackId: "1" })
		);
		expect(res.status).toBe(200);
		expect(res.headers.get("Cache-Control")).toBe("no-store");
		expect(res.headers.get("Accept-Ranges")).toBe("none");
		expect(res.headers.get("Content-Length")).toBe("9001");
		expect(acquireDownloadLock).toHaveBeenCalledWith("1", 320);
		expect(startProgressiveStreamMock).toHaveBeenCalledWith(
			expect.objectContaining({ persist: true, trackId: "1", bitrate: 320 })
		);
	});

	it("streams at the server quality saved since this instance started (was: kept the cold-start maxBitrate)", async () => {
		const { app, acquireDownloadLock } = makeApp({ maxBitrate: 1, savedBitrate: 3 });
		arrangeAuthOk(app);
		prismaMock.storedTrack.findMany.mockResolvedValue([]);
		startProgressiveStreamMock.mockResolvedValue({ body: fakeBody(), contentType: "audio/mpeg", contentLength: 0 });

		const res = await GET(makeNextRequest({ url: "http://localhost:3000/api/v1/stream-progressive/1" }), makeParams({ trackId: "1" }));
		expect(res.status).toBe(200);
		expect(acquireDownloadLock).toHaveBeenCalledWith("1", 3);
		expect(startProgressiveStreamMock).toHaveBeenCalledWith(expect.objectContaining({ bitrate: 3, settings: expect.objectContaining({ maxBitrate: 3 }) }));
	});

	it("preview mode: skips download lock and passes persist: false", async () => {
		const { app, acquireDownloadLock } = makeApp();
		arrangeAuthOk(app);
		prismaMock.storedTrack.findMany.mockResolvedValue([]);
		startProgressiveStreamMock.mockResolvedValue({
			body: fakeBody(),
			contentType: "audio/mpeg",
			contentLength: 0,
		});

		const res = await GET(
			makeNextRequest({
				url: "http://localhost:3000/api/v1/stream-progressive/1?preview=1",
			}),
			makeParams({ trackId: "1" })
		);
		expect(res.status).toBe(200);
		expect(acquireDownloadLock).not.toHaveBeenCalled();
		expect(startProgressiveStreamMock).toHaveBeenCalledWith(
			expect.objectContaining({ persist: false })
		);
	});

	it("head mode (preview=1&head=1): passes maxBytes: 64 * 1024", async () => {
		const { app } = makeApp();
		arrangeAuthOk(app);
		prismaMock.storedTrack.findMany.mockResolvedValue([]);
		startProgressiveStreamMock.mockResolvedValue({
			body: fakeBody(),
			contentType: "audio/mpeg",
			contentLength: 0,
		});

		const res = await GET(
			makeNextRequest({
				url: "http://localhost:3000/api/v1/stream-progressive/1?preview=1&head=1",
			}),
			makeParams({ trackId: "1" })
		);
		expect(res.status).toBe(200);
		expect(startProgressiveStreamMock).toHaveBeenCalledWith(
			expect.objectContaining({ persist: false, maxBytes: 64 * 1024 })
		);
	});

	it("head mode sizes the cap by seconds at the server quality (was: a flat 64 KiB, ~0.5 s of FLAC)", async () => {
		const { app } = makeApp({ maxBitrate: 9 });
		arrangeAuthOk(app);
		prismaMock.storedTrack.findMany.mockResolvedValue([]);
		startProgressiveStreamMock.mockResolvedValue({
			body: fakeBody(),
			contentType: "audio/flac",
			contentLength: 0,
		});

		const res = await GET(
			makeNextRequest({
				url: "http://localhost:3000/api/v1/stream-progressive/1?preview=1&head=1",
			}),
			makeParams({ trackId: "1" })
		);
		expect(res.status).toBe(200);
		expect(startProgressiveStreamMock).toHaveBeenCalledWith(
			expect.objectContaining({ persist: false, maxBytes: 360_000 })
		);
	});

	// C4 (contract change): a follower reads the holder's in-progress bytes at
	// once instead of waiting for its persist and bouncing to /stream.
	it("when lock is already in progress: streams the holder's in-progress bytes right away (was: waited up to 330 s without sending a byte, then 302)", async () => {
		const shared = { spool: {}, contentType: "audio/mpeg", totalLength: 3, rangeSupported: true };
		const { app, lock } = makeApp({ lockAlreadyInProgress: true, shared });
		arrangeAuthOk(app);
		prismaMock.storedTrack.findMany.mockResolvedValue([]);
		followMock.mockReturnValue({ body: fakeBody(), contentType: "audio/mpeg", contentLength: 3, totalLength: 3, start: 0, end: 2, rangeSupported: true, persisted: Promise.resolve() });

		const res = await GET(
			makeNextRequest({
				url: "http://localhost:3000/api/v1/stream-progressive/1",
			}),
			makeParams({ trackId: "1" })
		);
		expect(res.status).toBe(200);
		expect(res.headers.get("Content-Length")).toBe("3");
		expect(res.headers.get("Accept-Ranges")).toBe("bytes");
		expect(followMock).toHaveBeenCalledWith(shared);
		expect(lock.waitForExisting).not.toHaveBeenCalled();
		expect(startProgressiveStreamMock).not.toHaveBeenCalled();
		expect(prismaMock.persistLease.create).not.toHaveBeenCalled();
	});

	it("STORAGE_UNAVAILABLE: releases lock and 500s when app.storageProvider is null on a non-preview request", async () => {
		const { app, lock } = makeApp({ storageProvider: null });
		arrangeAuthOk(app);
		prismaMock.storedTrack.findMany.mockResolvedValue([]);

		const res = await GET(
			makeNextRequest({
				url: "http://localhost:3000/api/v1/stream-progressive/1",
			}),
			makeParams({ trackId: "1" })
		);
		expect(res.status).toBe(500);
		const body = await readJson<{ error: { code: string } }>(res);
		expect(body?.error.code).toBe("STORAGE_UNAVAILABLE");
		expect(lock.release).toHaveBeenCalled();
		expect(startProgressiveStreamMock).not.toHaveBeenCalled();
	});

	it("when startProgressiveStream throws: releases the lock and surfaces 500", async () => {
		const { app, lock } = makeApp();
		arrangeAuthOk(app);
		prismaMock.storedTrack.findMany.mockResolvedValue([]);
		startProgressiveStreamMock.mockRejectedValue(new Error("upstream broke"));

		const res = await GET(
			makeNextRequest({
				url: "http://localhost:3000/api/v1/stream-progressive/1",
			}),
			makeParams({ trackId: "1" })
		);
		expect(res.status).toBe(500);
		expect(lock.release).toHaveBeenCalled();
	});

	it("successful live stream emits no-store + Accept-Ranges: none", async () => {
		// Distinct from the basic "no stored row" case — explicitly locks in
		// header policy on the live-stream response (recent fix surface).
		const { app } = makeApp();
		arrangeAuthOk(app);
		prismaMock.storedTrack.findMany.mockResolvedValue([]);
		startProgressiveStreamMock.mockResolvedValue({
			body: fakeBody(),
			contentType: "audio/flac",
			contentLength: 0, // 0 → no Content-Length header
		});

		const res = await GET(
			makeNextRequest({
				url: "http://localhost:3000/api/v1/stream-progressive/1",
			}),
			makeParams({ trackId: "1" })
		);
		expect(res.status).toBe(200);
		expect(res.headers.get("Content-Type")).toBe("audio/flac");
		expect(res.headers.get("Cache-Control")).toBe("no-store");
		expect(res.headers.get("Accept-Ranges")).toBe("none");
		expect(res.headers.get("Content-Length")).toBeNull();
	});
	it("checks the MP3_320 copy rather than MP3_MISC (was: orderBy bitrate desc picked MP3_MISC=8 over MP3_320=3)", async () => {
		const { app } = makeApp();
		arrangeAuthOk(app);
		prismaMock.storedTrack.findMany.mockResolvedValue([
			{ ...blobRow, id: "misc", bitrate: 8, storagePath: "tracks/1/8.mp3" },
			{ ...blobRow, id: "hq", bitrate: 3, storagePath: "tracks/1/3.mp3" },
		]);
		blobStreamMock.headObject.mockResolvedValue({ contentLength: 1, contentType: "audio/mpeg" });

		const res = await GET(makeNextRequest({ url: "http://localhost:3000/api/v1/stream-progressive/1" }), makeParams({ trackId: "1" }));
		expect(res.status).toBe(302);
		expect(blobStreamMock.headObject).toHaveBeenCalledWith("tracks/1/3.mp3");
	});

	it("re-persists when the cached copy is below the listener's quality (was: the free account's 128 copy was redirected to forever)", async () => {
		const { app } = makeApp({ maxBitrate: 3 });
		arrangeAuthOk(app);
		prismaMock.deezerCredential.findUnique.mockResolvedValue({ canStreamHq: true, canStreamLossless: false });
		prismaMock.storedTrack.findMany.mockResolvedValue([{ ...blobRow, bitrate: 1, requestedBitrate: 1 }]);
		startProgressiveStreamMock.mockResolvedValue({ body: fakeBody(), contentType: "audio/mpeg", contentLength: 0 });

		const res = await GET(makeNextRequest({ url: "http://localhost:3000/api/v1/stream-progressive/1" }), makeParams({ trackId: "1" }));
		expect(res.status).toBe(200);
		expect(blobStreamMock.headObject).not.toHaveBeenCalled();
		expect(startProgressiveStreamMock).toHaveBeenCalledWith(expect.objectContaining({ persist: true, bitrate: 3 }));
	});
	describe("C4: plays never wait for another persist", () => {
		const url = "http://localhost:3000/api/v1/stream-progressive/1";
		function liveResult() {
			return { body: fakeBody(), contentType: "audio/mpeg", contentLength: 3, totalLength: 3, start: 0, end: 2, rangeSupported: true, persisted: Promise.resolve() };
		}

		it("streams live when the same-instance holder never opened its stream", async () => {
			const { app } = makeApp({ lockAlreadyInProgress: true, shared: null });
			arrangeAuthOk(app);
			prismaMock.storedTrack.findMany.mockResolvedValue([]);
			startProgressiveStreamMock.mockResolvedValue(liveResult());

			const res = await GET(makeNextRequest({ url }), makeParams({ trackId: "1" }));
			expect(res.status).toBe(200);
			expect(followMock).not.toHaveBeenCalled();
			expect(startProgressiveStreamMock).toHaveBeenCalledWith(expect.objectContaining({ persist: false }));
		});

		it("streams live when the holder's spool is gone", async () => {
			const { app } = makeApp({ lockAlreadyInProgress: true, shared: { spool: {} } });
			arrangeAuthOk(app);
			prismaMock.storedTrack.findMany.mockResolvedValue([]);
			followMock.mockReturnValue(null);
			startProgressiveStreamMock.mockResolvedValue(liveResult());

			const res = await GET(makeNextRequest({ url }), makeParams({ trackId: "1" }));
			expect(res.status).toBe(200);
			expect(startProgressiveStreamMock).toHaveBeenCalledWith(expect.objectContaining({ persist: false }));
		});

		it("streams live without persisting while another instance holds the lease (was: both instances downloaded and uploaded the track)", async () => {
			const { app, lock } = makeApp();
			arrangeAuthOk(app);
			prismaMock.storedTrack.findMany.mockResolvedValue([]);
			prismaMock.persistLease.create.mockRejectedValue(Object.assign(new Error("unique"), { code: "P2002" }));
			prismaMock.persistLease.updateMany.mockResolvedValue({ count: 0 });
			startProgressiveStreamMock.mockResolvedValue(liveResult());

			const res = await GET(makeNextRequest({ url }), makeParams({ trackId: "1" }));
			expect(res.status).toBe(200);
			expect(lock.release).toHaveBeenCalled();
			expect(startProgressiveStreamMock).toHaveBeenCalledWith(expect.objectContaining({ persist: false }));
			expect(afterMock).not.toHaveBeenCalled();
		});

		it("persists under the lease and hands both the lock and the lease to the engine", async () => {
			const { app, lock } = makeApp();
			arrangeAuthOk(app);
			prismaMock.storedTrack.findMany.mockResolvedValue([]);
			startProgressiveStreamMock.mockResolvedValue(liveResult());

			await GET(makeNextRequest({ url }), makeParams({ trackId: "1" }));
			expect(prismaMock.persistLease.create).toHaveBeenCalledWith({
				data: expect.objectContaining({ trackId: "1", bitrate: 320 }),
			});
			const opts = startProgressiveStreamMock.mock.calls[0][0];
			expect(opts).toMatchObject({ persist: true, lock: { release: lock.release, publish: lock.publish } });
			expect(opts.lease.holder).toEqual(expect.any(String));
		});

		it("keys the lock and lease by the listener's quality (server quality capped by licence)", async () => {
			const { app, acquireDownloadLock } = makeApp({ maxBitrate: 9 });
			arrangeAuthOk(app);
			prismaMock.deezerCredential.findUnique.mockResolvedValue({ canStreamHq: true, canStreamLossless: false });
			prismaMock.storedTrack.findMany.mockResolvedValue([]);
			startProgressiveStreamMock.mockResolvedValue(liveResult());

			await GET(makeNextRequest({ url }), makeParams({ trackId: "1" }));
			expect(acquireDownloadLock).toHaveBeenCalledWith("1", 3);
			expect(startProgressiveStreamMock).toHaveBeenCalledWith(expect.objectContaining({ bitrate: 9 }));
		});

		it("still persists when the lease table is unreachable (fail open)", async () => {
			const { app } = makeApp();
			arrangeAuthOk(app);
			prismaMock.storedTrack.findMany.mockResolvedValue([]);
			prismaMock.persistLease.create.mockRejectedValue(new Error("db down"));
			startProgressiveStreamMock.mockResolvedValue(liveResult());

			const res = await GET(makeNextRequest({ url }), makeParams({ trackId: "1" }));
			expect(res.status).toBe(200);
			expect(startProgressiveStreamMock).toHaveBeenCalledWith(expect.objectContaining({ persist: true, lease: undefined }));
		});

		it("releases the lease when the engine fails before streaming", async () => {
			const { app, lock } = makeApp();
			arrangeAuthOk(app);
			prismaMock.storedTrack.findMany.mockResolvedValue([]);
			startProgressiveStreamMock.mockRejectedValue(new Error("upstream broke"));

			const res = await GET(makeNextRequest({ url }), makeParams({ trackId: "1" }));
			expect(res.status).toBe(500);
			expect(lock.release).toHaveBeenCalled();
			expect(prismaMock.persistLease.deleteMany).toHaveBeenCalled();
		});
	});

	describe("C2: Range", () => {
		const url = "http://localhost:3000/api/v1/stream-progressive/1";
		function result(over: Record<string, unknown> = {}) {
			return { body: fakeBody(), contentType: "audio/mpeg", contentLength: 1000, totalLength: 1000, start: 0, end: 999, rangeSupported: true, persisted: Promise.resolve(), ...over };
		}
		function arrange() {
			const ctx = makeApp();
			arrangeAuthOk(ctx.app);
			prismaMock.storedTrack.findMany.mockResolvedValue([]);
			return ctx;
		}

		it("sends Content-Length and Accept-Ranges: bytes on a full play (was: no Content-Length and Accept-Ranges: none, so no seeking until cached)", async () => {
			arrange();
			startProgressiveStreamMock.mockResolvedValue(result());
			const res = await GET(makeNextRequest({ url }), makeParams({ trackId: "1" }));
			expect(res.status).toBe(200);
			expect(res.headers.get("Content-Length")).toBe("1000");
			expect(res.headers.get("Accept-Ranges")).toBe("bytes");
			expect(res.headers.get("Content-Range")).toBeNull();
		});

		it("answers bytes=0- with 206 and the whole track's Content-Range, persisting as usual", async () => {
			arrange();
			startProgressiveStreamMock.mockResolvedValue(result());
			const res = await GET(makeNextRequest({ url, headers: { range: "bytes=0-" } }), makeParams({ trackId: "1" }));
			expect(res.status).toBe(206);
			expect(res.headers.get("Content-Range")).toBe("bytes 0-999/1000");
			expect(res.headers.get("Content-Length")).toBe("1000");
			expect(startProgressiveStreamMock).toHaveBeenCalledWith(expect.objectContaining({ persist: true }));
		});

		it("answers bytes=0- with 200 and Accept-Ranges: none when the CDN refuses ranges, still with Content-Length", async () => {
			arrange();
			startProgressiveStreamMock.mockResolvedValue(result({ rangeSupported: false }));
			const res = await GET(makeNextRequest({ url, headers: { range: "bytes=0-" } }), makeParams({ trackId: "1" }));
			expect(res.status).toBe(200);
			expect(res.headers.get("Accept-Ranges")).toBe("none");
			expect(res.headers.get("Content-Length")).toBe("1000");
		});

		it("persists a play that opens with bytes=0-1 and answers only those bytes (was: Safari / AVPlayer's bytes=0-1 then bytes=0-n were live-only, so iOS plays never cached the track)", async () => {
			arrange();
			let cancelled = false;
			const body = new ReadableStream<Uint8Array>({
				start(c) {
					c.enqueue(new Uint8Array([1, 2, 3, 4]));
				},
				cancel() {
					cancelled = true;
				},
			});
			startProgressiveStreamMock.mockResolvedValue(result({ body }));

			const res = await GET(makeNextRequest({ url, headers: { range: "bytes=0-1" } }), makeParams({ trackId: "1" }));
			expect(res.status).toBe(206);
			expect(res.headers.get("Content-Range")).toBe("bytes 0-1/1000");
			expect(res.headers.get("Content-Length")).toBe("2");
			expect(res.headers.get("Accept-Ranges")).toBe("bytes");
			expect(Array.from(new Uint8Array(await res.arrayBuffer()))).toEqual([1, 2]);
			// The rest of the spool reader is released; the persist goes on.
			expect(cancelled).toBe(true);
			expect(startProgressiveStreamMock).toHaveBeenCalledWith(expect.objectContaining({ persist: true }));
			expect(startProgressiveStreamMock.mock.calls[0][0].range).toBeUndefined();
			expect(afterMock).toHaveBeenCalledOnce();
		});

		it("errors a capped bytes=0-n body when the stream fails before the window is sent", async () => {
			arrange();
			const body = new ReadableStream<Uint8Array>({
				start(c) {
					c.enqueue(new Uint8Array([1]));
					c.error(new Error("truncated"));
				},
			});
			startProgressiveStreamMock.mockResolvedValue(result({ body }));
			const res = await GET(makeNextRequest({ url, headers: { range: "bytes=0-9" } }), makeParams({ trackId: "1" }));
			expect(res.status).toBe(206);
			await expect(res.arrayBuffer()).rejects.toThrow("truncated");
		});

		it("persists bytes=0-n and clamps an end past the track to the whole file", async () => {
			arrange();
			startProgressiveStreamMock.mockResolvedValue(result());
			const res = await GET(makeNextRequest({ url, headers: { range: "bytes=0-5000" } }), makeParams({ trackId: "1" }));
			expect(res.status).toBe(206);
			expect(res.headers.get("Content-Range")).toBe("bytes 0-999/1000");
			expect(res.headers.get("Content-Length")).toBe("1000");
			expect(startProgressiveStreamMock).toHaveBeenCalledWith(expect.objectContaining({ persist: true }));
		});

		it("serves bytes=0-n to a same-instance follower from the holder's spool, capped to the window", async () => {
			const { app } = makeApp({ lockAlreadyInProgress: true, shared: { spool: {} } });
			arrangeAuthOk(app);
			prismaMock.storedTrack.findMany.mockResolvedValue([]);
			const body = new ReadableStream<Uint8Array>({
				start(c) {
					c.enqueue(new Uint8Array([9, 8, 7]));
					c.close();
				},
			});
			followMock.mockReturnValue(result({ body }));

			const res = await GET(makeNextRequest({ url, headers: { range: "bytes=0-1" } }), makeParams({ trackId: "1" }));
			expect(res.status).toBe(206);
			expect(res.headers.get("Content-Range")).toBe("bytes 0-1/1000");
			expect(Array.from(new Uint8Array(await res.arrayBuffer()))).toEqual([9, 8]);
			expect(startProgressiveStreamMock).not.toHaveBeenCalled();
		});

		it("answers bytes=0-1 with the whole track (200) when the CDN refuses ranges", async () => {
			arrange();
			startProgressiveStreamMock.mockResolvedValue(result({ rangeSupported: false }));
			const res = await GET(makeNextRequest({ url, headers: { range: "bytes=0-1" } }), makeParams({ trackId: "1" }));
			expect(res.status).toBe(200);
			expect(res.headers.get("Accept-Ranges")).toBe("none");
			expect(res.headers.get("Content-Length")).toBe("1000");
			expect(res.headers.get("Content-Range")).toBeNull();
		});

		it("serves a mid-track range live-only: 206, never persisted, no lock (was: Range ignored, a seek restarted the track)", async () => {
			const { acquireDownloadLock } = arrange();
			startProgressiveStreamMock.mockResolvedValue(result({ start: 100, end: 199, contentLength: 100 }));
			const req = makeNextRequest({ url, headers: { range: "bytes=100-199" } });

			const res = await GET(req, makeParams({ trackId: "1" }));
			expect(res.status).toBe(206);
			expect(res.headers.get("Content-Range")).toBe("bytes 100-199/1000");
			expect(res.headers.get("Content-Length")).toBe("100");
			expect(res.headers.get("Accept-Ranges")).toBe("bytes");
			expect(startProgressiveStreamMock).toHaveBeenCalledWith(
				expect.objectContaining({ persist: false, range: { start: 100, end: 199 }, signal: req.signal })
			);
			expect(acquireDownloadLock).not.toHaveBeenCalled();
			expect(prismaMock.persistLease.create).not.toHaveBeenCalled();
			expect(afterMock).not.toHaveBeenCalled();
		});

		it("passes an open-ended range through", async () => {
			arrange();
			startProgressiveStreamMock.mockResolvedValue(result({ start: 500, end: 999, contentLength: 500 }));
			const res = await GET(makeNextRequest({ url, headers: { range: "bytes=500-" } }), makeParams({ trackId: "1" }));
			expect(res.status).toBe(206);
			expect(startProgressiveStreamMock.mock.calls[0][0].range).toEqual({ start: 500, end: undefined });
		});

		it("falls back to a normal play when the CDN refuses ranges", async () => {
			const { acquireDownloadLock } = arrange();
			startProgressiveStreamMock
				.mockRejectedValueOnce(new RangeNotSupportedError())
				.mockResolvedValueOnce(result({ rangeSupported: false }));
			const res = await GET(makeNextRequest({ url, headers: { range: "bytes=100-" } }), makeParams({ trackId: "1" }));
			expect(res.status).toBe(200);
			expect(res.headers.get("Accept-Ranges")).toBe("none");
			expect(acquireDownloadLock).toHaveBeenCalled();
			expect(startProgressiveStreamMock.mock.calls[1][0]).toMatchObject({ persist: true });
		});

		it("answers 416 past the end", async () => {
			arrange();
			startProgressiveStreamMock.mockRejectedValue(new RangeNotSatisfiableError(1000));
			const res = await GET(makeNextRequest({ url, headers: { range: "bytes=5000-" } }), makeParams({ trackId: "1" }));
			expect(res.status).toBe(416);
			expect(res.headers.get("Content-Range")).toBe("bytes */1000");
		});

		it("serves malformed or multi-part ranges as a normal play", async () => {
			arrange();
			startProgressiveStreamMock.mockResolvedValue(result());
			const res = await GET(makeNextRequest({ url, headers: { range: "bytes=0-1,5-6" } }), makeParams({ trackId: "1" }));
			expect(res.status).toBe(200);
			expect(startProgressiveStreamMock).toHaveBeenCalledWith(expect.objectContaining({ persist: true }));
		});

		it("keeps preview responses unchanged (no Content-Length, no ranges)", async () => {
			arrange();
			startProgressiveStreamMock.mockResolvedValue(result());
			const res = await GET(makeNextRequest({ url: url + "?preview=1", headers: { range: "bytes=100-" } }), makeParams({ trackId: "1" }));
			expect(res.status).toBe(200);
			expect(res.headers.get("Content-Length")).toBeNull();
			expect(res.headers.get("Accept-Ranges")).toBe("none");
			expect(startProgressiveStreamMock.mock.calls[0][0].range).toBeUndefined();
		});
	});

	describe("C3: ?probe=1", () => {
		const url = "http://localhost:3000/api/v1/stream-progressive/1?probe=1";

		it("reports a cached track without touching Deezer or storage", async () => {
			const { app } = makeApp();
			arrangeAuthOk(app);
			prismaMock.storedTrack.findMany.mockResolvedValue([blobRow]);

			const res = await GET(makeNextRequest({ url }), makeParams({ trackId: "1" }));
			expect(res.status).toBe(200);
			expect(await readJson(res)).toEqual({ success: true, data: { ok: true, cached: true } });
			expect(blobStreamMock.headObject).not.toHaveBeenCalled();
			expect(probeMock).not.toHaveBeenCalled();
		});

		it("probes Deezer for an uncached track and never opens the audio stream", async () => {
			const { app, acquireDownloadLock } = makeApp();
			arrangeAuthOk(app);
			prismaMock.storedTrack.findMany.mockResolvedValue([]);
			probeMock.mockResolvedValue(undefined);

			const res = await GET(makeNextRequest({ url }), makeParams({ trackId: "1" }));
			expect(await readJson(res)).toEqual({ success: true, data: { ok: true, cached: false } });
			expect(probeMock).toHaveBeenCalledWith(expect.anything(), "1", 320, expect.anything());
			expect(startProgressiveStreamMock).not.toHaveBeenCalled();
			expect(acquireDownloadLock).not.toHaveBeenCalled();
		});

		it.each([
			[new UpstreamHttpError(404), 422, "TRACK_UNAVAILABLE"],
			[Object.assign(new Error("x"), { name: "WrongLicense" }), 422, "TRACK_UNAVAILABLE"],
			[new UpstreamTimeoutError("response", 10_000), 502, "UPSTREAM_ERROR"],
			[new Error("something odd"), 502, "UPSTREAM_ERROR"],
		])("maps %s to %i %s", async (error, status, code) => {
			const { app } = makeApp();
			arrangeAuthOk(app);
			prismaMock.storedTrack.findMany.mockResolvedValue([]);
			probeMock.mockRejectedValue(error);

			const res = await GET(makeNextRequest({ url }), makeParams({ trackId: "1" }));
			expect(res.status).toBe(status);
			expect(await readJson(res)).toMatchObject({ success: false, error: { code } });
		});

		it("keeps the auth envelopes", async () => {
			const res = await GET(makeNextRequest({ url }), makeParams({ trackId: "1" }));
			expect(res.status).toBe(401);
		});
	});

	it("maps a track this account cannot stream to 422 TRACK_UNAVAILABLE (was: 500 INTERNAL_ERROR)", async () => {
		const { app } = makeApp();
		arrangeAuthOk(app);
		prismaMock.storedTrack.findMany.mockResolvedValue([]);
		startProgressiveStreamMock.mockRejectedValue(Object.assign(new Error("no FLAC licence"), { name: "WrongLicense" }));

		const res = await GET(makeNextRequest({ url: "http://localhost:3000/api/v1/stream-progressive/1" }), makeParams({ trackId: "1" }));
		expect(res.status).toBe(422);
		expect(await readJson(res)).toMatchObject({ error: { code: "TRACK_UNAVAILABLE" } });
	});

	it("maps a failing Deezer CDN to 502 UPSTREAM_ERROR (was: 500 INTERNAL_ERROR)", async () => {
		const { app } = makeApp();
		arrangeAuthOk(app);
		prismaMock.storedTrack.findMany.mockResolvedValue([]);
		startProgressiveStreamMock.mockRejectedValue(new UpstreamHttpError(503));

		const res = await GET(makeNextRequest({ url: "http://localhost:3000/api/v1/stream-progressive/1" }), makeParams({ trackId: "1" }));
		expect(res.status).toBe(502);
		expect(await readJson(res)).toMatchObject({ error: { code: "UPSTREAM_ERROR" } });
	});
});
