// @vitest-environment node
import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, readFileSync, existsSync } from "fs";
import os from "os";
import path from "path";
import { Readable } from "stream";
import { ReadableStream } from "stream/web";
import { AudioUnavailableError, fetchExcerptAudio, prefixBytes, TAIL_MARGIN_MS, type AudioSourceDeps } from "./audio-source";

const dir = mkdtempSync(path.join(os.tmpdir(), "story-audio-"));
let n = 0;
const file = () => path.join(dir, `a${n++}`);

const bytes = (len: number) => Buffer.from(Array.from({ length: len }, (_, i) => i % 251));
const webStream = (buf: Buffer) =>
	new ReadableStream<Uint8Array>({
		start(c) {
			for (let i = 0; i < buf.length; i += 1000) c.enqueue(new Uint8Array(buf.subarray(i, i + 1000)));
			c.close();
		},
	});

function deps(over: Partial<AudioSourceDeps> = {}): AudioSourceDeps {
	return {
		findCopy: vi.fn(async () => null),
		readObject: vi.fn(async () => null),
		openDeezer: vi.fn(async () => {
			throw new AudioUnavailableError("NO_DEEZER", "no session");
		}),
		...over,
	};
}

const opts = (f: string) => ({ userId: "u1", trackId: "42", endMs: 60_000, trackDurationMs: 240_000, file: f });

describe("prefixBytes", () => {
	it("takes the share of the file up to the excerpt's end plus a margin", () => {
		// 240 s, 2.4 MB → 10 bytes per ms
		expect(prefixBytes(2_400_000, 240_000, 60_000)).toBe((60_000 + TAIL_MARGIN_MS) * 10 + 64 * 1024);
	});
	it("never asks past the file", () => {
		expect(prefixBytes(1_000, 240_000, 239_000)).toBe(1_000);
	});
	it("keeps the whole file when its size or the track's length is unknown", () => {
		expect(prefixBytes(0, 240_000, 60_000)).toBe(0);
		expect(prefixBytes(5_000, 0, 60_000)).toBe(5_000);
	});
});

describe("fetchExcerptAudio", () => {
	it("reads only the start of the cached copy, up to past the excerpt", async () => {
		const data = bytes(1_000_000);
		const d = deps({
			findCopy: vi.fn(async () => ({ storagePath: "tracks/42/3.mp3", fileSize: 2_400_000 })),
			readObject: vi.fn(async () => webStream(data)),
		});
		const f = file();
		const out = await fetchExcerptAudio(opts(f), d);
		expect(out.origin).toBe("cache");
		expect(d.readObject).toHaveBeenCalledWith("tracks/42/3.mp3", prefixBytes(2_400_000, 240_000, 60_000) - 1);
		expect(readFileSync(f).equals(data)).toBe(true);
		expect(d.openDeezer).not.toHaveBeenCalled();
		await out.cleanup();
		expect(existsSync(f)).toBe(false);
	});

	it("reads the whole cached copy when its size is unknown", async () => {
		const d = deps({ findCopy: vi.fn(async () => ({ storagePath: "p", fileSize: null })), readObject: vi.fn(async () => webStream(bytes(10))) });
		await fetchExcerptAudio(opts(file()), d);
		expect(d.readObject).toHaveBeenCalledWith("p", null);
	});

	it("falls back to Deezer when the cached copy cannot be read (was: the render failed on a stale row)", async () => {
		const abort = vi.fn();
		const d = deps({
			findCopy: vi.fn(async () => ({ storagePath: "p", fileSize: 100 })),
			readObject: vi.fn(async () => {
				throw new Error("NotFound");
			}),
			openDeezer: vi.fn(async () => ({ readable: Readable.from([bytes(500)]), totalLength: 500, abort })),
		});
		const out = await fetchExcerptAudio(opts(file()), d);
		expect(out.origin).toBe("deezer");
	});

	it("falls back to Deezer when the copy lookup fails", async () => {
		const d = deps({
			findCopy: vi.fn(async () => {
				throw new Error("db down");
			}),
			openDeezer: vi.fn(async () => ({ readable: Readable.from([bytes(10)]), totalLength: null, abort: vi.fn() })),
		});
		expect((await fetchExcerptAudio(opts(file()), d)).origin).toBe("deezer");
	});

	it("stops reading Deezer past the excerpt and closes the stream", async () => {
		const abort = vi.fn();
		const total = 2_400_000;
		const chunks = Array.from({ length: 240 }, () => bytes(10_000));
		const d = deps({ openDeezer: vi.fn(async () => ({ readable: Readable.from(chunks), totalLength: total, abort })) });
		const f = file();
		await fetchExcerptAudio(opts(f), d);
		expect(readFileSync(f).length).toBe(prefixBytes(total, 240_000, 60_000));
		expect(abort).toHaveBeenCalled();
	});

	it("passes on NO_DEEZER when there is no cached copy and no Deezer session", async () => {
		await expect(fetchExcerptAudio(opts(file()), deps())).rejects.toMatchObject({ code: "NO_DEEZER" });
	});

	it("turns a Deezer stream that breaks mid-way into AUDIO_UNAVAILABLE and removes the partial file", async () => {
		const f = file();
		const broken = new Readable({
			read() {
				this.push(bytes(100));
				this.destroy(new Error("TruncatedStreamError"));
			},
		});
		const d = deps({ openDeezer: vi.fn(async () => ({ readable: broken, totalLength: 1_000_000, abort: vi.fn() })) });
		await expect(fetchExcerptAudio(opts(f), d)).rejects.toMatchObject({ code: "AUDIO_UNAVAILABLE" });
		expect(existsSync(f)).toBe(false);
	});

	it("refuses an empty Deezer stream", async () => {
		const d = deps({ openDeezer: vi.fn(async () => ({ readable: Readable.from([]), totalLength: 0, abort: vi.fn() })) });
		await expect(fetchExcerptAudio(opts(file()), d)).rejects.toMatchObject({ code: "AUDIO_UNAVAILABLE" });
	});
});
