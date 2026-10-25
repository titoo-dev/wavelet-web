// @vitest-environment node
import { describe, it, expect } from "vitest";
import { execFileSync, spawnSync } from "child_process";
import { existsSync, mkdtempSync, statSync } from "fs";
import os from "os";
import path from "path";
import ffmpegStatic from "ffmpeg-static";
import { parseLyricsRange, type LyricsRange } from "./range";
import { ffmpegArgs, renderStoryVideo, RenderFailedError } from "./render";

function range(): LyricsRange {
	const r = parseLyricsRange({
		lines: [
			{ timeMs: 2_000, text: "First line" },
			{ timeMs: 4_000, text: "Ничего не говори" },
		],
		nextLineMs: 7_500,
		trackDurationMs: 20_000,
	});
	if (!r.ok) throw new Error(r.message);
	return r.range;
}

describe("ffmpegArgs", () => {
	const args = ffmpegArgs({ range: range(), audioFile: "/tmp/a", outFile: "/tmp/o.mp4", width: 1080, height: 1920, fps: 30, preset: "veryfast" });
	const after = (flag: string, from = 0) => args[args.indexOf(flag, from) + 1];

	it("reads raw RGBA frames of the story size from stdin", () => {
		expect(args.slice(args.indexOf("-f"), args.indexOf("pipe:0") + 1)).toEqual(["-f", "rawvideo", "-pix_fmt", "rgba", "-s", "1080x1920", "-r", "30", "-i", "pipe:0"]);
	});
	it("seeks the audio to the excerpt and cuts it to its length", () => {
		const audioAt = args.indexOf("/tmp/a");
		expect(args.slice(audioAt - 5, audioAt + 1)).toEqual(["-ss", "1.700", "-t", "5.800", "-i", "/tmp/a"]);
	});
	it("fades the audio in and out over 0.3 s", () => {
		expect(after("-af")).toBe("afade=t=in:st=0:d=0.300,afade=t=out:st=5.500:d=0.300");
	});
	it("encodes H.264 yuv420p + AAC 192 kbps, fast-start MP4", () => {
		expect(after("-c:v")).toBe("libx264");
		expect(after("-pix_fmt", args.indexOf("-c:v"))).toBe("yuv420p");
		expect(after("-c:a")).toBe("aac");
		expect(after("-b:a")).toBe("192k");
		expect(after("-movflags")).toBe("+faststart");
		expect(args[args.length - 1]).toBe("/tmp/o.mp4");
	});
});

const ffmpeg = ffmpegStatic as unknown as string | null;
const haveFfmpeg = !!ffmpeg && existsSync(ffmpeg);

describe.runIf(haveFfmpeg)("renderStoryVideo (real ffmpeg)", () => {
	const dir = mkdtempSync(path.join(os.tmpdir(), "story-render-"));
	const audio = path.join(dir, "tone.mp3");
	execFileSync(ffmpeg as string, ["-loglevel", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100", "-t", "20", "-b:a", "128k", audio]);

	it("writes an MP4 of the excerpt's length and reports progress up to 1", async () => {
		const out = path.join(dir, "out.mp4");
		const progress: number[] = [];
		await renderStoryVideo({
			story: { range: range(), theme: "vinyl", title: "T", artist: "A", cover: null },
			audioFile: audio,
			outFile: out,
			size: { width: 180, height: 320 },
			fps: 10,
			preset: "ultrafast",
			onProgress: (p) => progress.push(p),
		});
		expect(statSync(out).size).toBeGreaterThan(1000);
		const info = spawnSync(ffmpeg as string, ["-hide_banner", "-i", out], { encoding: "utf8" }).stderr;
		expect(info).toMatch(/Duration: 00:00:05\.[78]/);
		expect(info).toMatch(/Video: h264.*yuv420p.*180x320/);
		expect(info).toMatch(/Audio: aac/);
		expect(progress[progress.length - 1]).toBe(1);
		expect(progress.every((p, i) => i === 0 || p >= progress[i - 1])).toBe(true);
	}, 60_000);

	it("fails with RenderFailedError when the audio file is not audio", async () => {
		await expect(
			renderStoryVideo({
				story: { range: range(), theme: "minimal", title: "T", artist: "A", cover: null },
				audioFile: path.join(dir, "missing.mp3"),
				outFile: path.join(dir, "bad.mp4"),
				size: { width: 180, height: 320 },
				fps: 10,
				preset: "ultrafast",
			})
		).rejects.toBeInstanceOf(RenderFailedError);
	}, 60_000);
});

describe("renderStoryVideo without ffmpeg", () => {
	it("fails with RenderFailedError when the binary cannot start (was: the frame loop waited forever for a drain)", async () => {
		await expect(
			renderStoryVideo({
				story: { range: range(), theme: "minimal", title: "T", artist: "A", cover: null },
				audioFile: "x",
				outFile: path.join(os.tmpdir(), "never.mp4"),
				size: { width: 90, height: 160 },
				fps: 5,
				ffmpegPath: path.join(os.tmpdir(), "no-such-ffmpeg-binary"),
			})
		).rejects.toBeInstanceOf(RenderFailedError);
	});
});
