import { describe, it, expect } from "vitest";
import { oklchToRgb, oklch } from "./color";
import { rgbToOklch } from "@/lib/cover-palette";

describe("oklchToRgb", () => {
	it("maps white and black", () => {
		expect(oklchToRgb(1, 0, 0)).toEqual([255, 255, 255]);
		expect(oklchToRgb(0, 0, 0)).toEqual([0, 0, 0]);
	});

	it("round-trips with cover-palette's rgbToOklch", () => {
		for (const [r, g, b] of [[129, 140, 248], [220, 38, 38], [22, 163, 74], [250, 204, 21]]) {
			const { l, c, h } = rgbToOklch(r, g, b);
			const back = oklchToRgb(l, c, h);
			back.forEach((v, i) => expect(Math.abs(v - [r, g, b][i])).toBeLessThanOrEqual(1));
		}
	});

	it("clips out-of-gamut colours to sRGB", () => {
		for (const v of oklchToRgb(0.7, 0.4, 150)) {
			expect(v).toBeGreaterThanOrEqual(0);
			expect(v).toBeLessThanOrEqual(255);
		}
	});
});

describe("oklch", () => {
	it("writes a CSS rgb() colour, with alpha below 1", () => {
		expect(oklch(1, 0, 0)).toBe("rgb(255 255 255)");
		expect(oklch(0, 0, 0, 0.5)).toBe("rgb(0 0 0 / 0.5)");
	});
});
