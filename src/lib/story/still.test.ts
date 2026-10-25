// @vitest-environment node
import { describe, it, expect, vi } from "vitest";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { BRAND_SEED } from "@/lib/cover-palette";
import { parseLyricsRange, type LyricsRange } from "./range";
import { coverSeed, loadCover, prepareStory, renderStill, STILL_SIZE } from "./still";
import { STORY_THEMES, THEMES } from "./themes";

const COVER = "https://cdn-images.dzcdn.net/images/cover/abc/250x250-000000-80-0-0.jpg";

function range(lines: { timeMs: number; text: string }[], nextLineMs: number | null = 76_000): LyricsRange {
	const r = parseLyricsRange({ lines, nextLineMs, trackDurationMs: 240_000 });
	if (!r.ok) throw new Error(r.message);
	return r.range;
}

const sample = range([
	{ timeMs: 60_000, text: "Like the legend of the phoenix" },
	{ timeMs: 64_000, text: "Ce qu'on garde pour soi finit toujours par se dire un soir" },
	{ timeMs: 68_000, text: "" },
	{ timeMs: 70_000, text: "Ничего не говори 🎵" },
	{ timeMs: 73_000, text: "Αγάπη μου" },
]);

async function solidPng(r: number, g: number, b: number) {
	const c = createCanvas(32, 32);
	const ctx = c.getContext("2d");
	ctx.fillStyle = `rgb(${r} ${g} ${b})`;
	ctx.fillRect(0, 0, 32, 32);
	return c.encode("png");
}

const okFetch = (bytes: Buffer) => vi.fn(async () => new Response(new Uint8Array(bytes), { status: 200 })) as unknown as typeof fetch;

describe("loadCover", () => {
	it("never fetches an address outside Deezer's CDN (was: any client URL)", async () => {
		const f = vi.fn() as unknown as typeof fetch;
		expect(await loadCover("https://evil.example/cover.jpg", f)).toBeNull();
		expect(await loadCover("http://cdn-images.dzcdn.net/x.jpg", f)).toBeNull();
		expect(await loadCover(undefined, f)).toBeNull();
		expect(f).not.toHaveBeenCalled();
	});

	it("asks for the 1000 px cover and decodes it", async () => {
		const f = okFetch(await solidPng(200, 30, 30));
		const img = await loadCover(COVER, f);
		expect(img?.width).toBe(32);
		expect(vi.mocked(f).mock.calls[0][0]).toBe("https://cdn-images.dzcdn.net/images/cover/abc/1000x1000-000000-80-0-0.jpg");
	});

	it("gives null on an HTTP error, an empty or undecodable body, or a network failure", async () => {
		expect(await loadCover(COVER, vi.fn(async () => new Response("no", { status: 404 })) as unknown as typeof fetch)).toBeNull();
		expect(await loadCover(COVER, okFetch(Buffer.alloc(0)))).toBeNull();
		expect(await loadCover(COVER, okFetch(Buffer.from("not an image")))).toBeNull();
		expect(await loadCover(COVER, vi.fn(async () => { throw new Error("ECONNRESET"); }) as unknown as typeof fetch)).toBeNull();
	});

	it("refuses a cover over 5 MB", async () => {
		expect(await loadCover(COVER, okFetch(Buffer.alloc(5 * 1024 * 1024 + 1)))).toBeNull();
	});
});

describe("coverSeed", () => {
	it("is the brand seed without a cover", () => {
		expect(coverSeed(null)).toEqual(BRAND_SEED);
	});
	it("follows the cover's colour", async () => {
		const red = await loadImage(await solidPng(220, 30, 30));
		const seed = coverSeed(red);
		expect(seed.hue < 40 || seed.hue > 340).toBe(true);
		expect(seed.chroma).toBeGreaterThan(0.5);
	});
});

describe("renderStill", () => {
	it.each(STORY_THEMES)("draws a %s Theme Still as a 720×1280 JPEG, with Latin, Cyrillic, Greek and emoji lines", async (theme) => {
		const cover = await loadImage(await solidPng(30, 90, 200));
		const jpeg = await renderStill({ range: sample, theme, title: "A title long enough to need cutting at the edge of the frame", artist: "Artist", cover });
		expect(jpeg.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
		const img = await loadImage(jpeg);
		expect([img.width, img.height]).toEqual([STILL_SIZE.width, STILL_SIZE.height]);
	});

	it.each(STORY_THEMES)("draws %s without a cover", async (theme) => {
		const jpeg = await renderStill({ range: sample, theme, title: "T", artist: "A", cover: null });
		expect(jpeg.length).toBeGreaterThan(1000);
	});
});

describe("Story Themes over time", () => {
	const pixels = (theme: (typeof STORY_THEMES)[number], tMs: number) => {
		const size = { width: 270, height: 480 };
		const story = prepareStory({ range: sample, theme, title: "T", artist: "A", cover: null }, size);
		const c = createCanvas(size.width, size.height);
		const ctx = c.getContext("2d");
		THEMES[theme].draw(ctx, story, tMs);
		return Buffer.from(ctx.getImageData(0, 0, size.width, size.height).data);
	};

	it.each(STORY_THEMES)("%s moves when the next line comes in", (theme) => {
		const before = pixels(theme, 2_000);
		const after = pixels(theme, 64_000 - sample.startMs + 500);
		expect(before.equals(after)).toBe(false);
	});

	it("vinyl turns the record between two frames of the same line", () => {
		expect(pixels("vinyl", 1_000).equals(pixels("vinyl", 1_500))).toBe(false);
	});

	it("blurred-cover stays still while a line plays", () => {
		expect(pixels("blurred-cover", 1_000).equals(pixels("blurred-cover", 2_000))).toBe(true);
	});
});
