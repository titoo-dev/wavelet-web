// Theme Stills (CONTEXT.md): one frame of a Lyrics Range in a Story Theme, drawn by the same code
// as the video, so what the listener picks is what they get. Also the shared setup of a story
// (cover, seed, prepared theme) that the video render builds on.
import { createCanvas, loadImage, type Image } from "@napi-rs/canvas";
import { BRAND_SEED, seedFromPixels, sizedCover, type CoverSeed } from "@/lib/cover-palette";
import { safeCoverUrl } from "@/lib/share-meta";
import { registerStoryFonts } from "./fonts";
import type { LyricsRange } from "./range";
import { stillTimeMs } from "./timeline";
import { THEMES, type PreparedStory, type StoryThemeId } from "./themes";

/** Size of a Lyrics Story. */
export const STORY_SIZE = { width: 1080, height: 1920 } as const;
/** Size of a Theme Still: two thirds of the video, plenty for a phone carousel. */
export const STILL_SIZE = { width: 720, height: 1280 } as const;

const COVER_TIMEOUT_MS = 5_000;
const MAX_COVER_BYTES = 5 * 1024 * 1024;

/**
 * The decoded cover, or null: only https Deezer artwork (share-meta's allow-list, so the server
 * never fetches an address a client picked), asked at 1000 px, within 5 s and 5 MB.
 */
export async function loadCover(url: string | null | undefined, fetchImpl: typeof fetch = fetch): Promise<Image | null> {
	const safe = safeCoverUrl(url);
	if (!safe) return null;
	try {
		const res = await fetchImpl(sizedCover(safe, 1000), { signal: AbortSignal.timeout(COVER_TIMEOUT_MS) });
		if (!res.ok) return null;
		const bytes = Buffer.from(await res.arrayBuffer());
		if (bytes.length === 0 || bytes.length > MAX_COVER_BYTES) return null;
		return await loadImage(bytes);
	} catch {
		return null;
	}
}

/** The cover's seed colour, as CoverTheme picks it; the brand seed without a cover. */
export function coverSeed(cover: Image | null): CoverSeed {
	if (!cover) return BRAND_SEED;
	const canvas = createCanvas(48, 48);
	const ctx = canvas.getContext("2d");
	ctx.drawImage(cover, 0, 0, 48, 48);
	return seedFromPixels(ctx.getImageData(0, 0, 48, 48).data);
}

export interface StoryRequest {
	range: LyricsRange;
	theme: StoryThemeId;
	title: string;
	artist: string;
	cover: Image | null;
}

/** A story ready to draw at `size`: fonts registered, seed picked, the theme's static layer built. */
export function prepareStory(req: StoryRequest, size: { width: number; height: number }): PreparedStory {
	registerStoryFonts();
	return THEMES[req.theme].prepare({
		range: req.range,
		title: req.title,
		artist: req.artist,
		cover: req.cover,
		seed: coverSeed(req.cover),
		width: size.width,
		height: size.height,
	});
}

/** The Theme Still of a request, as a JPEG. */
export async function renderStill(req: StoryRequest, size: { width: number; height: number } = STILL_SIZE): Promise<Buffer> {
	const story = prepareStory(req, size);
	const canvas = createCanvas(size.width, size.height);
	THEMES[req.theme].draw(canvas.getContext("2d"), story, stillTimeMs(req.range));
	return canvas.encode("jpeg", 86);
}
