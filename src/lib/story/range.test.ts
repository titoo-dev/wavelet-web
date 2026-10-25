import { describe, it, expect } from "vitest";
import { cleanLineText, excerptBounds, parseLyricsRange, MAX_LINES, MAX_LINE_CHARS } from "./range";

const lines = (times: number[]) => times.map((timeMs, i) => ({ timeMs, text: `line ${i}` }));

describe("excerptBounds", () => {
	it("starts 0.3 s before the first line and ends where the next line starts", () => {
		expect(excerptBounds(10_000, 20_000, 24_000, 200_000)).toEqual({ startMs: 9_700, endMs: 24_000 });
	});
	it("never starts below 0", () => {
		expect(excerptBounds(100, 5_000, 9_000, 200_000).startMs).toBe(0);
	});
	it("runs 4 s past the song's last line, never past the track's end", () => {
		expect(excerptBounds(180_000, 190_000, null, 200_000).endMs).toBe(194_000);
		expect(excerptBounds(180_000, 198_000, null, 200_000).endMs).toBe(200_000);
	});
});

describe("parseLyricsRange", () => {
	const base = { lines: lines([10_000, 14_000, 18_000]), nextLineMs: 22_000, trackDurationMs: 200_000 };

	it("accepts a range and returns its excerpt", () => {
		const r = parseLyricsRange(base);
		expect(r).toEqual({
			ok: true,
			range: { lines: base.lines, startMs: 9_700, endMs: 22_000, durationMs: 12_300 },
		});
	});

	it("accepts the song's last lines with nextLineMs null or absent", () => {
		const r = parseLyricsRange({ lines: lines([190_000, 194_000]), nextLineMs: null, trackDurationMs: 200_000 });
		expect(r.ok && r.range.endMs).toBe(198_000);
		expect(parseLyricsRange({ lines: lines([190_000, 194_000]), trackDurationMs: 200_000 }).ok).toBe(true);
	});

	it.each([
		["no lines", { ...base, lines: [] }],
		["too many lines", { ...base, lines: lines(Array.from({ length: MAX_LINES + 1 }, (_, i) => i * 100)) }],
		["lines not an array", { ...base, lines: "x" }],
		["no track duration", { ...base, trackDurationMs: undefined }],
		["a zero track duration", { ...base, trackDurationMs: 0 }],
		["a line without time", { ...base, lines: [{ text: "a" }] }],
		["a negative time", { ...base, lines: [{ timeMs: -1, text: "a" }] }],
		["a NaN time", { ...base, lines: [{ timeMs: Number.NaN, text: "a" }] }],
		["times going backwards", { ...base, lines: lines([14_000, 10_000]) }],
		["a line after the track's end", { ...base, lines: lines([10_000, 250_000]) }],
		["no text at all", { ...base, lines: [{ timeMs: 10_000, text: "  " }] }],
		["nextLineMs before the last line", { ...base, nextLineMs: 18_000 }],
		["a non-numeric nextLineMs", { ...base, nextLineMs: "22000" }],
		["an excerpt under 5 s", { ...base, lines: lines([10_000]), nextLineMs: 14_000 }],
		["an excerpt over 60 s", { ...base, nextLineMs: 75_000 }],
	])("refuses %s", (_name, input) => {
		expect(parseLyricsRange(input as never).ok).toBe(false);
	});

	it("keeps equal times (repeated LRC stamps) and empty lines between sung ones", () => {
		const r = parseLyricsRange({
			lines: [{ timeMs: 10_000, text: "a" }, { timeMs: 10_000, text: "" }, { timeMs: 12_000, text: "b" }],
			nextLineMs: 16_000,
			trackDurationMs: 200_000,
		});
		expect(r.ok && r.range.lines.map((l) => l.text)).toEqual(["a", "", "b"]);
	});

	it("says how long the refused excerpt lasts", () => {
		const r = parseLyricsRange({ ...base, nextLineMs: 80_000 });
		expect(!r.ok && r.message).toContain("70.3 s");
	});

	it("accepts a whole chorus up to 60 s (was: capped at 30 s, too short for a chorus)", () => {
		const chorus = lines(Array.from({ length: 16 }, (_, i) => 10_000 + i * 3_500));
		const r = parseLyricsRange({ lines: chorus, nextLineMs: 69_000, trackDurationMs: 200_000 });
		expect(r.ok && r.range.durationMs).toBe(59_300);
		expect(parseLyricsRange({ lines: chorus, nextLineMs: 70_000, trackDurationMs: 200_000 }).ok).toBe(false);
	});
});

describe("cleanLineText", () => {
	it("trims, collapses spaces and strips control and bidi-override characters", () => {
		expect(cleanLineText("  Hello\u0007  ‮world​ \n again ")).toBe("Hello world again");
	});
	it("caps the length", () => {
		expect(cleanLineText("x".repeat(MAX_LINE_CHARS + 50))).toHaveLength(MAX_LINE_CHARS);
	});
	it("turns non-strings into an empty line", () => {
		expect(cleanLineText(42)).toBe("");
		expect(cleanLineText(undefined)).toBe("");
	});
	it("keeps accents, Cyrillic and Greek", () => {
		expect(cleanLineText("Ça va — Ничего — Αγάπη")).toBe("Ça va — Ничего — Αγάπη");
	});
});
