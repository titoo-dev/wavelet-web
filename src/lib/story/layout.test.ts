import { describe, it, expect } from "vitest";
import { wrapText, layoutLyrics, ellipsize, MAX_ROWS, type Measure } from "./layout";

// Every character is fontSize / 2 wide.
const measure: Measure = (text, fontSize) => Array.from(text).length * (fontSize / 2);

describe("wrapText", () => {
	it("keeps a line that fits on one row", () => {
		expect(wrapText("hello world", 1000, 20, measure)).toEqual(["hello world"]);
	});
	it("wraps on spaces", () => {
		// 10 px per char → 60 px = 6 chars per row
		expect(wrapText("aaa bbb ccc", 60, 20, measure)).toEqual(["aaa", "bbb", "ccc"]);
		expect(wrapText("aa bb cc", 60, 20, measure)).toEqual(["aa bb", "cc"]);
	});
	it("splits a word wider than the row by characters", () => {
		expect(wrapText("abcdefghij x", 40, 20, measure)).toEqual(["abcd", "efgh", "ij x"]);
	});
	it("returns one empty row for an empty line", () => {
		expect(wrapText("", 100, 20, measure)).toEqual([""]);
	});
	it("counts characters, not UTF-16 units", () => {
		expect(wrapText("🎵🎵🎵🎵", 40, 20, measure)).toEqual(["🎵🎵🎵🎵"]);
	});
});

describe("layoutLyrics", () => {
	it("takes the largest size at which every line fits in MAX_ROWS rows", () => {
		const texts = ["one two three four five six"];
		// 27 chars; at 40 px (20/char) width 200 → 10 chars/row → 3 rows ok; at 60 px → 6 chars/row → 5 rows
		const out = layoutLyrics(texts, 200, [60, 40, 20], measure);
		expect(out.fontSize).toBe(40);
		expect(out.rows[0].length).toBeLessThanOrEqual(MAX_ROWS);
	});
	it("cuts a line still too long at the smallest size, with an ellipsis", () => {
		const out = layoutLyrics(["a b c d e f g h"], 10, [20], measure);
		expect(out.fontSize).toBe(20);
		expect(out.rows[0]).toHaveLength(MAX_ROWS);
		expect(out.rows[0][MAX_ROWS - 1].endsWith("…")).toBe(true);
	});
	it("lays out every line with the same size", () => {
		const out = layoutLyrics(["short", "a much longer line here"], 200, [60, 40], measure);
		expect(out.rows).toHaveLength(2);
	});
});

describe("ellipsize", () => {
	it("keeps text that fits", () => {
		expect(ellipsize("Daft Punk", 1000, 20, measure)).toBe("Daft Punk");
	});
	it("cuts text that does not, with an ellipsis", () => {
		expect(ellipsize("A very long title", 80, 20, measure)).toBe("A very…");
	});
});
