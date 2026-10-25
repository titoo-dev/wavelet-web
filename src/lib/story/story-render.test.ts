// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest";
import { writeFile } from "fs/promises";
import { mkdtempSync } from "fs";
import os from "os";
import path from "path";
import { prismaMock, resetPrismaMock } from "@/test/helpers/mockPrisma";

vi.mock("@/lib/prisma", () => ({ prisma: prismaMock }));

import {
	collectStoryGarbage,
	DAILY_RENDER_LIMIT,
	failStuckRenders,
	linesHash,
	publicRender,
	requestRender,
	runRender,
	storyObjectKey,
	STORY_TTL_MS,
	STUCK_RENDER_MS,
	type RunRenderDeps,
	type StoryRenderRow,
} from "./story-render";
import { AudioUnavailableError } from "./audio-source";
import { RenderFailedError } from "./render";
import type { LyricsRange } from "./range";

const now = new Date("2026-10-25T12:00:00Z");
const range: LyricsRange = {
	lines: [
		{ timeMs: 60_000, text: "a" },
		{ timeMs: 64_000, text: "b" },
	],
	startMs: 59_700,
	endMs: 68_000,
	durationMs: 8_300,
};
const input = { trackId: "42", theme: "palette" as const, title: "T", artist: "A", coverUrl: null, trackDurationMs: 200_000, nextLineMs: 68_000, range };

const row = (over: Partial<StoryRenderRow> = {}): StoryRenderRow => ({
	id: "r1",
	userId: "u1",
	trackId: "42",
	theme: "palette",
	startMs: 59_700,
	endMs: 68_000,
	status: "queued",
	progress: 0,
	storagePath: null,
	size: null,
	error: null,
	createdAt: now,
	updatedAt: now,
	readyAt: null,
	...over,
});

beforeEach(() => {
	resetPrismaMock();
	prismaMock.storyRender.updateMany.mockResolvedValue({ count: 0 });
	prismaMock.storyRender.findFirst.mockResolvedValue(null);
	prismaMock.storyRender.count.mockResolvedValue(0);
	prismaMock.storyRender.create.mockImplementation(async ({ data }: { data: object }) => row({ ...data, id: "new" }));
	prismaMock.storyRender.update.mockResolvedValue({});
});

describe("linesHash", () => {
	it("changes with a line's time or text, not with anything else", () => {
		const h = linesHash(range.lines);
		expect(linesHash([...range.lines])).toBe(h);
		expect(linesHash([{ timeMs: 60_001, text: "a" }, range.lines[1]])).not.toBe(h);
		expect(linesHash([{ timeMs: 60_000, text: "A" }, range.lines[1]])).not.toBe(h);
	});
});

describe("requestRender", () => {
	it("creates a queued render with the request, its lines and their hash", async () => {
		const out = await requestRender("u1", input, now);
		expect(out.kind).toBe("created");
		expect(prismaMock.storyRender.create.mock.calls[0][0].data).toMatchObject({
			userId: "u1",
			trackId: "42",
			theme: "palette",
			startMs: 59_700,
			endMs: 68_000,
			linesHash: linesHash(range.lines),
			lines: range.lines,
			trackDurationMs: 200_000,
			nextLineMs: 68_000,
		});
	});

	it("reuses the same request's render when it is live or ready less than 24 h ago", async () => {
		prismaMock.storyRender.findFirst.mockResolvedValueOnce(row({ status: "ready" }));
		const out = await requestRender("u1", input, now);
		expect(out).toMatchObject({ kind: "reused", render: { id: "r1" } });
		const where = prismaMock.storyRender.findFirst.mock.calls[0][0].where;
		expect(where).toMatchObject({ userId: "u1", trackId: "42", theme: "palette", startMs: 59_700, endMs: 68_000, linesHash: linesHash(range.lines) });
		expect(where.OR[1].readyAt.gt).toEqual(new Date(now.getTime() - STORY_TTL_MS));
		expect(prismaMock.storyRender.create).not.toHaveBeenCalled();
	});

	it("refuses a second render while one is under way", async () => {
		prismaMock.storyRender.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(row({ id: "running", status: "rendering" }));
		expect(await requestRender("u1", input, now)).toMatchObject({ kind: "busy", render: { id: "running" } });
		expect(prismaMock.storyRender.create).not.toHaveBeenCalled();
	});

	it("stops at the daily limit, failures not counted", async () => {
		prismaMock.storyRender.count.mockResolvedValue(DAILY_RENDER_LIMIT);
		expect(await requestRender("u1", input, now)).toEqual({ kind: "limit" });
		expect(prismaMock.storyRender.count.mock.calls[0][0].where).toMatchObject({ userId: "u1", status: { not: "failed" } });
	});

	it("fails the user's stuck renders first, so a dead one never blocks the next", async () => {
		await requestRender("u1", input, now);
		expect(prismaMock.storyRender.updateMany.mock.calls[0][0]).toEqual({
			where: { userId: "u1", status: { in: ["queued", "rendering"] }, updatedAt: { lt: new Date(now.getTime() - STUCK_RENDER_MS) } },
			data: { status: "failed", error: "TIMED_OUT" },
		});
	});
});

describe("failStuckRenders", () => {
	it("covers every user without a user id", async () => {
		prismaMock.storyRender.updateMany.mockResolvedValue({ count: 3 });
		expect(await failStuckRenders(now)).toBe(3);
		expect(prismaMock.storyRender.updateMany.mock.calls[0][0].where.userId).toBeUndefined();
	});
});

describe("runRender", () => {
	const tmpDir = mkdtempSync(path.join(os.tmpdir(), "story-run-"));
	const fullRow = { ...row({ status: "rendering" }), lines: range.lines, title: "T", artist: "A", coverUrl: "https://cdn-images.dzcdn.net/c.jpg", trackDurationMs: 200_000 };

	function deps(over: Partial<RunRenderDeps> = {}): RunRenderDeps {
		return {
			audio: {
				findCopy: vi.fn(async () => null),
				readObject: vi.fn(async () => null),
				openDeezer: vi.fn(async () => ({ readable: (await import("stream")).Readable.from([Buffer.from("mp3")]), totalLength: 3, abort: vi.fn() })),
			},
			upload: vi.fn(async () => {}),
			render: vi.fn(async (o) => {
				o.onProgress?.(0.5);
				o.onProgress?.(0.52);
				await writeFile(o.outFile, Buffer.alloc(1234));
				o.onProgress?.(1);
			}),
			loadCover: vi.fn(async () => null),
			tmpDir,
			...over,
		};
	}

	beforeEach(() => {
		prismaMock.storyRender.updateMany.mockResolvedValue({ count: 1 });
		prismaMock.storyRender.findUnique.mockResolvedValue(fullRow);
	});

	it("claims the queued render, renders it, uploads it under stories/ and marks it ready", async () => {
		const d = deps();
		await runRender("r1", d);
		expect(prismaMock.storyRender.updateMany.mock.calls[0][0]).toEqual({ where: { id: "r1", status: "queued" }, data: { status: "rendering", progress: 0 } });
		const opts = vi.mocked(d.render).mock.calls[0][0];
		expect(opts.story).toMatchObject({ theme: "palette", title: "T", artist: "A", range: { startMs: 59_700, endMs: 68_000, durationMs: 8_300 } });
		expect(d.loadCover).toHaveBeenCalledWith("https://cdn-images.dzcdn.net/c.jpg");
		expect(d.upload).toHaveBeenCalledWith(storyObjectKey("u1", "r1"), expect.any(Buffer));
		const last = prismaMock.storyRender.update.mock.calls.at(-1)[0];
		expect(last).toMatchObject({ where: { id: "r1" }, data: { status: "ready", progress: 1, storagePath: "stories/u1/r1.mp4", size: 1234, error: null } });
		expect(last.data.readyAt).toBeInstanceOf(Date);
	});

	it("writes progress about every 10 %, scaled to 95 % for the drawing", async () => {
		await runRender("r1", deps());
		const progress = prismaMock.storyRender.update.mock.calls.map((c: [{ data: { progress?: number } }]) => c[0].data.progress).filter((p: number | undefined) => p !== undefined && p < 1);
		expect(progress).toEqual([0.48, 0.95]);
	});

	it("does nothing when another invocation already took the render", async () => {
		prismaMock.storyRender.updateMany.mockResolvedValue({ count: 0 });
		const d = deps();
		await runRender("r1", d);
		expect(d.render).not.toHaveBeenCalled();
	});

	it.each([
		["no Deezer session", new AudioUnavailableError("NO_DEEZER", "x"), "NO_DEEZER"],
		["Deezer refusing the track", new AudioUnavailableError("AUDIO_UNAVAILABLE", "x"), "AUDIO_UNAVAILABLE"],
	])("fails the render with %s", async (_n, err, code) => {
		const d = deps();
		d.audio.openDeezer = vi.fn(async () => {
			throw err;
		});
		await runRender("r1", d);
		expect(prismaMock.storyRender.update.mock.calls.at(-1)[0]).toEqual({ where: { id: "r1" }, data: { status: "failed", error: code } });
		expect(d.render).not.toHaveBeenCalled();
	});

	it("fails the render with RENDER_FAILED when ffmpeg or the upload fails", async () => {
		await runRender("r1", deps({ render: vi.fn(async () => { throw new RenderFailedError("ffmpeg exited with 1"); }) }));
		expect(prismaMock.storyRender.update.mock.calls.at(-1)[0].data).toEqual({ status: "failed", error: "RENDER_FAILED" });
		vi.spyOn(console, "error").mockImplementation(() => {});
		await runRender("r1", deps({ upload: vi.fn(async () => { throw new Error("R2 503"); }) }));
		expect(prismaMock.storyRender.update.mock.calls.at(-1)[0].data).toEqual({ status: "failed", error: "RENDER_FAILED" });
	});
});

describe("publicRender", () => {
	it("shows a ready render with its link and when it expires", () => {
		const readyAt = new Date(now.getTime() - 60_000);
		const out = publicRender(row({ status: "ready", progress: 1, readyAt, storagePath: "stories/u1/r1.mp4", size: 99 }), now, "https://r2/x");
		expect(out).toMatchObject({ status: "ready", url: "https://r2/x", size: 99, error: null, expiresAt: new Date(readyAt.getTime() + STORY_TTL_MS).toISOString() });
	});
	it("shows a ready render past 24 h, or whose object is gone, as expired, without a link", () => {
		const old = row({ status: "ready", readyAt: new Date(now.getTime() - STORY_TTL_MS - 1), storagePath: "stories/u1/r1.mp4" });
		expect(publicRender(old, now, "https://r2/x")).toMatchObject({ status: "expired", url: null, size: null });
		expect(publicRender(row({ status: "ready", readyAt: now, storagePath: null }), now)).toMatchObject({ status: "expired" });
	});
	it("shows a failed render's error code, RENDER_FAILED by default", () => {
		expect(publicRender(row({ status: "failed", error: "NO_DEEZER" }), now).error).toBe("NO_DEEZER");
		expect(publicRender(row({ status: "failed" }), now).error).toBe("RENDER_FAILED");
		expect(publicRender(row({ status: "rendering", progress: 0.4 }), now)).toMatchObject({ status: "rendering", progress: 0.4, url: null, error: null });
	});
});

describe("collectStoryGarbage", () => {
	it("deletes expired MP4s, keeps their rows, purges old rows and fails stuck renders", async () => {
		prismaMock.storyRender.findMany.mockResolvedValue([
			{ id: "a", storagePath: "stories/u1/a.mp4" },
			{ id: "b", storagePath: "stories/u1/b.mp4" },
		]);
		prismaMock.storyRender.deleteMany.mockResolvedValue({ count: 4 });
		prismaMock.storyRender.updateMany.mockResolvedValue({ count: 1 });
		const del = vi.fn(async (key: string) => {
			if (key.endsWith("b.mp4")) throw new Error("R2 down");
		});
		expect(await collectStoryGarbage(del, now)).toEqual({ objectsDeleted: 1, rowsPurged: 4, stuckFailed: 1, errors: 1 });
		expect(prismaMock.storyRender.update).toHaveBeenCalledWith({ where: { id: "a" }, data: { storagePath: null } });
		expect(prismaMock.storyRender.update).not.toHaveBeenCalledWith({ where: { id: "b" }, data: { storagePath: null } });
		// A row whose object could not be deleted is not purged: its key would be lost.
		expect(prismaMock.storyRender.deleteMany.mock.calls[0][0].where).toMatchObject({ storagePath: null });
	});
});
