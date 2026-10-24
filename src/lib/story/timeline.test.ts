import { describe, it, expect } from "vitest";
import { timelineAt, stillTimeMs, frameCount, ENTER_MS } from "./timeline";
import type { LyricsRange } from "./range";

// Excerpt 9.7 s → 22 s; lines at 10, 14 and 18 s.
const range: LyricsRange = {
	lines: [
		{ timeMs: 10_000, text: "a" },
		{ timeMs: 14_000, text: "b" },
		{ timeMs: 18_000, text: "c" },
	],
	startMs: 9_700,
	endMs: 22_000,
	durationMs: 12_300,
};

describe("timelineAt", () => {
	it("shows the first line, fully in, from the first frame (before it starts)", () => {
		expect(timelineAt(range, 0)).toEqual({ active: 0, enter: 1, scroll: 0 });
	});

	it("keeps the first line in while it plays", () => {
		expect(timelineAt(range, 2_000)).toEqual({ active: 0, enter: 1, scroll: 0 });
	});

	it("brings the next line in over ENTER_MS, eased, scrolling from the previous one", () => {
		const start = 14_000 - 9_700;
		const at0 = timelineAt(range, start);
		expect(at0).toMatchObject({ active: 1, enter: 0, scroll: 0 });
		const mid = timelineAt(range, start + ENTER_MS / 2);
		expect(mid.active).toBe(1);
		expect(mid.enter).toBeGreaterThan(0.5); // ease-out: past halfway at half time
		expect(mid.scroll).toBeCloseTo(mid.enter, 10);
		expect(timelineAt(range, start + ENTER_MS)).toEqual({ active: 1, enter: 1, scroll: 1 });
	});

	it("stays on the last line until the end", () => {
		expect(timelineAt(range, range.durationMs)).toEqual({ active: 2, enter: 1, scroll: 2 });
	});

	it("moves past lines that share a time", () => {
		const r = { ...range, lines: [range.lines[0], { timeMs: 14_000, text: "b" }, { timeMs: 14_000, text: "b2" }, range.lines[2]] };
		expect(timelineAt(r, 14_000 - 9_700 + ENTER_MS).active).toBe(2);
	});
});

describe("stillTimeMs", () => {
	it("is halfway through the first line", () => {
		expect(stillTimeMs(range)).toBe(12_000 - 9_700);
	});
	it("uses the excerpt's end when there is one line", () => {
		const one = { ...range, lines: [range.lines[0]], endMs: 16_000 };
		expect(stillTimeMs(one)).toBe(13_000 - 9_700);
	});
});

describe("frameCount", () => {
	it("rounds the excerpt to whole frames", () => {
		expect(frameCount(range, 30)).toBe(369);
		expect(frameCount({ ...range, durationMs: 30_000 }, 30)).toBe(900);
	});
});
