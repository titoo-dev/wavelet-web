// Where a Lyrics Story is at a given moment: which line is current and how far its entrance has
// gone. Pure, so every Story Theme animates the same way and the Theme Still shows a real frame.
import type { LyricsRange } from "./range";

/** How long a line takes to come in (scroll up, brighten). */
export const ENTER_MS = 350;

export interface TimelineState {
	/** Index of the current line; 0 before the first line starts. */
	active: number;
	/** 0 → 1 as the current line comes in (eased); 1 before the first line, which is shown at once. */
	enter: number;
	/** Fractional line position the lyrics are scrolled to: `active - (1 - enter)`, never below 0. */
	scroll: number;
}

const easeOutCubic = (x: number) => 1 - Math.pow(1 - x, 3);

/** The state at `tMs` from the start of the excerpt. */
export function timelineAt(range: LyricsRange, tMs: number): TimelineState {
	const at = range.startMs + tMs;
	let active = -1;
	for (let i = 0; i < range.lines.length; i++) if (range.lines[i].timeMs <= at) active = i;
	if (active <= 0) {
		// The first line is on screen from the first frame: there is nothing to scroll from.
		return { active: 0, enter: 1, scroll: 0 };
	}
	const into = Math.min(1, Math.max(0, (at - range.lines[active].timeMs) / ENTER_MS));
	const enter = easeOutCubic(into);
	return { active, enter, scroll: Math.max(0, active - (1 - enter)) };
}

/** The moment a Theme Still shows: halfway through the first line, from the start of the excerpt. */
export function stillTimeMs(range: LyricsRange): number {
	const first = range.lines[0].timeMs;
	const next = range.lines[1]?.timeMs ?? range.endMs;
	return Math.round((first + next) / 2 - range.startMs);
}

/** Number of frames of the excerpt at `fps`. */
export function frameCount(range: LyricsRange, fps: number): number {
	return Math.round((range.durationMs / 1000) * fps);
}
