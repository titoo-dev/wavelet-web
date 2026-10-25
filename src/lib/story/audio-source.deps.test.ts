// @vitest-environment node
// The production seams of audio-source.ts: StoredTrack + R2, and the user's Deezer session.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Readable } from "stream";

const m = vi.hoisted(() => ({
	findCachedCopy: vi.fn(),
	resolveCacheQuery: vi.fn(async () => ({ maxBitrate: 3, licence: null })),
	streamObject: vi.fn(),
	restoreUserDz: vi.fn(),
	getWaveletApp: vi.fn(),
	resolveStreamTrack: vi.fn(),
	openDecryptedStream: vi.fn(),
}));
vi.mock("@/lib/wavelet/storage/cached-copy", () => ({ findCachedCopy: m.findCachedCopy, resolveCacheQuery: m.resolveCacheQuery }));
vi.mock("@/lib/object-stream", () => ({ streamObject: m.streamObject }));
vi.mock("@/lib/deezer-session", () => ({ restoreUserDz: m.restoreUserDz }));
vi.mock("@/lib/server-state", () => ({ getWaveletApp: m.getWaveletApp }));
vi.mock("@/lib/wavelet/progressive-stream", () => ({ resolveStreamTrack: m.resolveStreamTrack }));
vi.mock("@/lib/wavelet/decryption", () => ({ openDecryptedStream: m.openDecryptedStream }));

import { defaultAudioSourceDeps as deps } from "./audio-source";

beforeEach(() => Object.values(m).forEach((f) => f.mockClear()));

describe("findCopy", () => {
	it("uses a hit, and an under-quality copy too (fine for an excerpt), with its size", async () => {
		m.findCachedCopy.mockResolvedValueOnce({ kind: "hit", row: { storagePath: "tracks/1/3.mp3", fileSize: 9 }, stale: [] });
		expect(await deps.findCopy("u1", "1")).toEqual({ storagePath: "tracks/1/3.mp3", fileSize: 9 });
		m.findCachedCopy.mockResolvedValueOnce({ kind: "upgrade", best: { storagePath: "tracks/1/1.mp3" }, stale: [] });
		expect(await deps.findCopy("u1", "1")).toEqual({ storagePath: "tracks/1/1.mp3", fileSize: null });
		expect(m.resolveCacheQuery).toHaveBeenCalledWith("u1");
	});
	it("is null on a miss", async () => {
		m.findCachedCopy.mockResolvedValueOnce({ kind: "miss", stale: [], aboveCap: false });
		expect(await deps.findCopy("u1", "1")).toBeNull();
	});
});

describe("readObject", () => {
	it("asks R2 for bytes 0 to end, or the whole object", async () => {
		m.streamObject.mockResolvedValue({ body: "BODY" });
		expect(await deps.readObject("p", 99)).toBe("BODY");
		expect(m.streamObject).toHaveBeenLastCalledWith("p", "bytes=0-99");
		await deps.readObject("p", null);
		expect(m.streamObject).toHaveBeenLastCalledWith("p", undefined);
		m.streamObject.mockResolvedValue({ body: null });
		expect(await deps.readObject("p", null)).toBeNull();
	});
});

describe("openDeezer", () => {
	const app = { freshSettings: vi.fn(async () => ({ fallbackBitrate: true })) };

	it("opens the whole decrypted track at 320, capped by the licence in resolveStreamTrack", async () => {
		m.restoreUserDz.mockResolvedValue({ status: "ok", dz: "DZ" });
		m.getWaveletApp.mockResolvedValue(app);
		m.resolveStreamTrack.mockResolvedValue({ track: { id: 1, downloadURL: "u", bitrate: 3 } });
		const abort = vi.fn();
		m.openDecryptedStream.mockResolvedValue({ readable: Readable.from([]), totalLength: 123, abort });
		const out = await deps.openDeezer("u1", "1");
		expect(m.resolveStreamTrack).toHaveBeenCalledWith("DZ", "1", 3, { fallbackBitrate: true });
		expect(out.totalLength).toBe(123);
		out.abort();
		expect(abort).toHaveBeenCalled();
	});

	it("is NO_DEEZER without a session", async () => {
		m.restoreUserDz.mockResolvedValue({ status: "no-arl" });
		await expect(deps.openDeezer("u1", "1")).rejects.toMatchObject({ code: "NO_DEEZER" });
	});

	it("is AUDIO_UNAVAILABLE without the engine, or when Deezer refuses the track", async () => {
		m.restoreUserDz.mockResolvedValue({ status: "ok", dz: "DZ" });
		m.getWaveletApp.mockResolvedValueOnce(null);
		await expect(deps.openDeezer("u1", "1")).rejects.toMatchObject({ code: "AUDIO_UNAVAILABLE" });
		m.getWaveletApp.mockResolvedValue(app);
		m.resolveStreamTrack.mockRejectedValueOnce(new Error("WrongLicense"));
		await expect(deps.openDeezer("u1", "1")).rejects.toMatchObject({ code: "AUDIO_UNAVAILABLE", message: expect.stringContaining("WrongLicense") });
	});
});
