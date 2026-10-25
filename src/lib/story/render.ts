// The video of a Lyrics Story: every frame drawn by the Story Theme on a canvas, piped raw (RGBA)
// to ffmpeg, which encodes it with the audio excerpt (docs/adr/0004). Only the drawing changes per
// frame: the theme's static layer and the lyrics layout are prepared once.
import { spawn } from "child_process";
import { createCanvas } from "@napi-rs/canvas";
import ffmpegStatic from "ffmpeg-static";
import { FADE_MS, type LyricsRange } from "./range";
import { frameCount } from "./timeline";
import { prepareStory, STORY_SIZE, type StoryRequest } from "./still";
import { THEMES } from "./themes";

export const STORY_FPS = 30;

/** The ffmpeg command line of a render. Pure, so the flags are tested without running ffmpeg. */
export function ffmpegArgs(opts: { range: LyricsRange; audioFile: string; outFile: string; width: number; height: number; fps: number; preset: string }): string[] {
	const { range, audioFile, outFile, width, height, fps, preset } = opts;
	const seconds = (ms: number) => (ms / 1000).toFixed(3);
	const fadeOutAt = Math.max(0, range.durationMs - FADE_MS);
	return [
		"-hide_banner", "-loglevel", "error", "-y",
		// Video: raw RGBA frames on stdin.
		"-f", "rawvideo", "-pix_fmt", "rgba", "-s", `${width}x${height}`, "-r", String(fps), "-i", "pipe:0",
		// Audio: the excerpt, seeked exactly (input seeking decodes up to the point on a local file).
		"-ss", seconds(range.startMs), "-t", seconds(range.durationMs), "-i", audioFile,
		"-map", "0:v:0", "-map", "1:a:0",
		"-c:v", "libx264", "-preset", preset, "-crf", "21", "-pix_fmt", "yuv420p", "-profile:v", "high",
		"-c:a", "aac", "-b:a", "192k", "-ar", "44100", "-ac", "2",
		"-af", `afade=t=in:st=0:d=${seconds(FADE_MS)},afade=t=out:st=${seconds(fadeOutAt)}:d=${seconds(FADE_MS)}`,
		"-t", seconds(range.durationMs),
		"-movflags", "+faststart",
		outFile,
	];
}

export class RenderFailedError extends Error {
	readonly name = "RenderFailedError";
}

export interface RenderVideoOptions {
	story: StoryRequest;
	audioFile: string;
	outFile: string;
	size?: { width: number; height: number };
	fps?: number;
	preset?: string;
	/** 0 → 1 as frames are drawn; called about once a second of video. */
	onProgress?: (progress: number) => void;
	ffmpegPath?: string;
}

/** Renders the Lyrics Story to `outFile` (MP4). Rejects with RenderFailedError when ffmpeg fails. */
export async function renderStoryVideo(opts: RenderVideoOptions): Promise<void> {
	const size = opts.size ?? STORY_SIZE;
	const fps = opts.fps ?? STORY_FPS;
	const bin = opts.ffmpegPath ?? (ffmpegStatic as unknown as string | null);
	if (!bin) throw new RenderFailedError("ffmpeg is not available on this platform.");

	const { range } = opts.story;
	const story = prepareStory(opts.story, size);
	const draw = THEMES[opts.story.theme].draw;
	const canvas = createCanvas(size.width, size.height);
	const ctx = canvas.getContext("2d");

	const ff = spawn(bin, ffmpegArgs({ range, audioFile: opts.audioFile, outFile: opts.outFile, width: size.width, height: size.height, fps, preset: opts.preset ?? "veryfast" }), {
		stdio: ["pipe", "ignore", "pipe"],
	});
	let stderr = "";
	ff.stderr.on("data", (d: Buffer) => {
		stderr = (stderr + d.toString()).slice(-4000);
	});
	// A binary that cannot start emits "error" and maybe never "close" (was: the frame loop waited
	// for a drain that never came).
	let spawnError: Error | null = null;
	let stdinClosed = false;
	const exited = new Promise<number>((resolve) => {
		ff.once("error", (e) => {
			spawnError = e;
			stdinClosed = true;
			resolve(-1);
		});
		ff.once("close", (code) => {
			stdinClosed = true;
			resolve(code ?? -1);
		});
	});
	// ffmpeg quitting early closes stdin: stop drawing instead of throwing EPIPE.
	ff.stdin.on("error", () => (stdinClosed = true));

	const frames = frameCount(range, fps);
	try {
		for (let f = 0; f < frames && !stdinClosed; f++) {
			draw(ctx, story, (f * 1000) / fps);
			if (!ff.stdin.write(canvas.data())) {
				await Promise.race([new Promise<void>((resolve) => ff.stdin.once("drain", () => resolve())), exited]);
			}
			if (f % fps === 0) opts.onProgress?.(f / frames);
		}
	} finally {
		ff.stdin.end();
	}
	const code = await exited;
	if (spawnError) throw new RenderFailedError(`ffmpeg could not start: ${(spawnError as Error).message}`);
	if (code !== 0) throw new RenderFailedError(`ffmpeg exited with ${code}: ${stderr.trim().split("\n").slice(-3).join(" | ")}`);
	opts.onProgress?.(1);
}
