// Live end-to-end Lyrics Story render, without database or R2: the service account decrypts the
// track from Deezer, LRCLIB gives the synced lyrics, and the same pipeline as a Story Render
// (fetchExcerptAudio → renderStoryVideo) writes the MP4.
//   npx tsx scripts/e2e-story.ts [trackId] [theme] [outDir]
// Needs WAVELET_SERVICE_ARL. Exits 1 when the video is not 1080×1920 H.264 + AAC of the excerpt's length.
import "dotenv/config";
import { config } from "dotenv";
import { spawnSync } from "child_process";
import { mkdirSync, statSync } from "fs";
import path from "path";
import ffmpegStatic from "ffmpeg-static";
import { Deezer } from "@/lib/deezer";
import { TrackFormats } from "@/lib/deezer/types";
import { findLyrics } from "@/lib/lyrics/resolve";
import { parseLrc } from "@/lib/lyrics/lrc";
import { resolveStreamTrack } from "@/lib/wavelet/progressive-stream";
import { openDecryptedStream } from "@/lib/wavelet/decryption";
import { DEFAULT_SETTINGS } from "@/lib/wavelet/settings";
import { fetchExcerptAudio } from "@/lib/story/audio-source";
import { parseLyricsRange, MAX_RANGE_MS } from "@/lib/story/range";
import { renderStoryVideo } from "@/lib/story/render";
import { loadCover } from "@/lib/story/still";
import { isStoryTheme } from "@/lib/story/themes";

config({ path: ".env.local" });

const trackId = process.argv[2] ?? "3135556";
const theme = process.argv[3] ?? "blurred-cover";
const outDir = process.argv[4] ?? "story-e2e";

async function main() {
	if (!isStoryTheme(theme)) throw new Error(`unknown theme ${theme}`);
	const arl = process.env.WAVELET_SERVICE_ARL;
	if (!arl) throw new Error("WAVELET_SERVICE_ARL is not set");
	const dz = new Deezer();
	if (!(await dz.loginViaArl(arl))) throw new Error("Deezer login failed");

	const meta = await dz.api.getTrack(trackId);
	const title: string = meta.title;
	const artist: string = meta.artist.name;
	const durationMs = meta.duration * 1000;
	const lyrics = await findLyrics({ title, artist, album: meta.album?.title, duration: meta.duration });
	if (!lyrics.syncedLyrics) throw new Error(`no synced lyrics for ${artist} — ${title}`);
	const all = parseLrc(lyrics.syncedLyrics).map((l) => ({ timeMs: Math.round(l.time * 1000), text: l.text }));

	// Lines from a third into the song, as many as fit in MAX_RANGE_MS.
	const from = all.findIndex((l) => l.timeMs > durationMs / 3);
	let to = from;
	while (to + 1 < all.length && (all[to + 2]?.timeMs ?? durationMs) - all[from].timeMs + 300 <= MAX_RANGE_MS) to++;
	const parsed = parseLyricsRange({ lines: all.slice(from, to + 1), nextLineMs: all[to + 1]?.timeMs ?? null, trackDurationMs: durationMs });
	if (!parsed.ok) throw new Error(parsed.message);
	const { range } = parsed;
	console.log(`${artist} — ${title}: ${range.lines.length} lines, ${(range.startMs / 1000).toFixed(1)}–${(range.endMs / 1000).toFixed(1)} s (lyrics: ${lyrics.source})`);

	mkdirSync(outDir, { recursive: true });
	const audioFile = path.join(outDir, `${trackId}.audio`);
	const outFile = path.join(outDir, `${trackId}-${theme}.mp4`);
	const t0 = performance.now();
	const audio = await fetchExcerptAudio(
		{ userId: "e2e", trackId, endMs: range.endMs, trackDurationMs: durationMs, file: audioFile },
		{
			findCopy: async () => null,
			readObject: async () => null,
			async openDeezer() {
				const { track } = await resolveStreamTrack(dz, trackId, TrackFormats.MP3_320, DEFAULT_SETTINGS);
				const s = await openDecryptedStream(track);
				return { readable: s.readable, totalLength: s.totalLength, abort: () => s.abort() };
			},
		}
	);
	const tAudio = performance.now() - t0;
	const cover = await loadCover(meta.album?.cover_xl);
	await renderStoryVideo({ story: { range, theme, title, artist, cover }, audioFile, outFile });
	const tTotal = performance.now() - t0;
	await audio.cleanup();

	const info = spawnSync(ffmpegStatic as unknown as string, ["-hide_banner", "-i", outFile], { encoding: "utf8" }).stderr;
	const duration = /Duration: (\d+):(\d+):([\d.]+)/.exec(info);
	const seconds = duration ? Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3]) : NaN;
	const checks: [string, boolean][] = [
		["1080×1920 H.264 yuv420p", /Video: h264.*yuv420p.*1080x1920/.test(info)],
		["AAC audio", /Audio: aac/.test(info)],
		[`length ${(range.durationMs / 1000).toFixed(2)} s (got ${seconds.toFixed(2)})`, Math.abs(seconds - range.durationMs / 1000) < 0.15],
	];
	for (const [label, ok] of checks) console.log(`${ok ? "ok  " : "FAIL"} ${label}`);
	console.log(`audio ${audio.origin} in ${Math.round(tAudio)} ms, total ${Math.round(tTotal)} ms, ${(statSync(outFile).size / 1024 / 1024).toFixed(2)} MB → ${outFile}`);
	if (checks.some(([, ok]) => !ok)) process.exit(1);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
