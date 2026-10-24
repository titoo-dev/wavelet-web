// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest";

beforeEach(() => vi.resetModules());

describe("registerStoryFonts", () => {
	it("registers Geist and Noto Sans from assets/fonts/story", async () => {
		const { registerStoryFonts } = await import("./fonts");
		const { GlobalFonts } = await import("@napi-rs/canvas");
		registerStoryFonts();
		const families = GlobalFonts.families.map((f) => f.family);
		expect(families).toEqual(expect.arrayContaining(["Geist", "Noto Sans"]));
	});

	it("throws when a font file is missing, instead of drawing with a fallback font", async () => {
		const { registerStoryFonts } = await import("./fonts");
		expect(() => registerStoryFonts("/nowhere")).toThrow("Story font not found: Geist-SemiBold.ttf");
	});
});
