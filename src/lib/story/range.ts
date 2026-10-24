// A Lyrics Range as the client sends it (CONTEXT.md, docs/adr/0005): the lines it showed, with their
// times in the track, plus where the next line starts. The server trusts none of it: this module
// checks it and works out the audio excerpt (docs/lyrics-stories.md § Règles).

export const MIN_RANGE_MS = 5_000;
export const MAX_RANGE_MS = 30_000;
/** The excerpt starts this long before the first line. */
export const LEAD_MS = 300;
/** After the last line of the song, the excerpt runs this long. */
export const TAIL_MS = 4_000;
/** Fade in and fade out of the audio. */
export const FADE_MS = 300;
export const MAX_LINES = 30;
export const MAX_LINE_CHARS = 200;
const MAX_TRACK_MS = 24 * 60 * 60 * 1000;

/** One synced lyric line: when it starts in the track (ms) and its text. */
export interface StoryLine {
	timeMs: number;
	text: string;
}

/** A checked Lyrics Range and the audio excerpt it makes. Times are in the track, in ms. */
export interface LyricsRange {
	lines: StoryLine[];
	startMs: number;
	endMs: number;
	durationMs: number;
}

// Both members name both fields: the project builds without strictNullChecks, where `ok` alone does not narrow.
export type RangeResult = { ok: true; range: LyricsRange; message?: undefined } | { ok: false; message: string; range?: undefined };

const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g;

/** Trimmed, single-spaced, without control or bidi-override characters, at most MAX_LINE_CHARS. */
export function cleanLineText(value: unknown): string {
	if (typeof value !== "string") return "";
	return value.replace(CONTROL_CHARS, " ").replace(/\s+/g, " ").trim().slice(0, MAX_LINE_CHARS);
}

const isTime = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= MAX_TRACK_MS;

/**
 * The audio excerpt of a Lyrics Range: from LEAD_MS before the first line (never below 0) to the
 * start of the line after the last one, or TAIL_MS after the last line when it ends the song, never
 * past the track's end.
 */
export function excerptBounds(firstMs: number, lastMs: number, nextLineMs: number | null, trackMs: number) {
	const startMs = Math.max(0, firstMs - LEAD_MS);
	const endMs = Math.min(trackMs, nextLineMs ?? lastMs + TAIL_MS);
	return { startMs, endMs };
}

/**
 * Checks a Lyrics Range sent by a client: `lines` (1 to MAX_LINES, `{ timeMs, text }`, times
 * non-decreasing, at least one line with text), `nextLineMs` (start of the line after the last
 * one, or null when the last one ends the song) and `trackDurationMs`. The excerpt must last
 * MIN_RANGE_MS to MAX_RANGE_MS.
 */
export function parseLyricsRange(input: { lines?: unknown; nextLineMs?: unknown; trackDurationMs?: unknown }): RangeResult {
	const { lines: rawLines, nextLineMs, trackDurationMs } = input;
	if (!Array.isArray(rawLines) || rawLines.length === 0 || rawLines.length > MAX_LINES) {
		return { ok: false, message: `lines must hold 1 to ${MAX_LINES} lines.` };
	}
	if (!isTime(trackDurationMs) || trackDurationMs === 0) {
		return { ok: false, message: "trackDurationMs must be the track's length in ms." };
	}
	if (nextLineMs !== null && nextLineMs !== undefined && !isTime(nextLineMs)) {
		return { ok: false, message: "nextLineMs must be a time in ms, or null after the song's last line." };
	}

	const lines: StoryLine[] = [];
	for (const raw of rawLines) {
		const timeMs = (raw as { timeMs?: unknown })?.timeMs;
		if (!isTime(timeMs)) return { ok: false, message: "Every line needs a timeMs in ms." };
		if (lines.length && timeMs < lines[lines.length - 1].timeMs) {
			return { ok: false, message: "Line times must not go backwards." };
		}
		if (timeMs >= trackDurationMs) return { ok: false, message: "A line starts after the end of the track." };
		lines.push({ timeMs: Math.round(timeMs), text: cleanLineText((raw as { text?: unknown }).text) });
	}
	if (!lines.some((l) => l.text)) return { ok: false, message: "The lines have no text." };

	const last = lines[lines.length - 1].timeMs;
	const next = typeof nextLineMs === "number" ? nextLineMs : null;
	if (next !== null && next <= last) return { ok: false, message: "nextLineMs must come after the last line." };

	const { startMs, endMs } = excerptBounds(lines[0].timeMs, last, next === null ? null : Math.round(next), Math.round(trackDurationMs));
	const durationMs = endMs - startMs;
	if (durationMs < MIN_RANGE_MS || durationMs > MAX_RANGE_MS) {
		return { ok: false, message: `The excerpt must last ${MIN_RANGE_MS / 1000} to ${MAX_RANGE_MS / 1000} s (it lasts ${(durationMs / 1000).toFixed(1)} s).` };
	}
	return { ok: true, range: { lines, startMs, endMs, durationMs } };
}
