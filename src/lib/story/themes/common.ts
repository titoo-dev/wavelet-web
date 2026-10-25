// Drawing pieces shared by the Story Themes. Sizes are written for 1080×1920 and scaled with `u`.
import { createCanvas, type Canvas, type Image, type SKRSContext2D } from "@napi-rs/canvas";
import { layoutLyrics, ellipsize, type LyricsLayout, type Measure } from "../layout";
import type { TimelineState } from "../timeline";

/** Geist first, Noto Sans for the glyphs Geist lacks (Cyrillic, Greek…). */
export const FONT_STACK = `Geist, "Noto Sans"`;

export const font = (size: number, weight: 600 | 700 = 600) => `${weight} ${Math.round(size)}px ${FONT_STACK}`;

/** Scale factor from the 1080-wide design to `width`. */
export const unitOf = (width: number) => width / 1080;

/** A canvas text measure at `weight`, for layout.ts. */
export function measureWith(ctx: SKRSContext2D, weight: 600 | 700): Measure {
	return (text, size) => {
		ctx.font = font(size, weight);
		return ctx.measureText(text).width;
	};
}

/** Lays out the range's lines for a lyrics column `maxWidth` wide, trying `sizes` (design px) largest first. */
export function layoutFor(ctx: SKRSContext2D, texts: string[], maxWidth: number, sizes: number[], u: number, weight: 600 | 700): LyricsLayout {
	return layoutLyrics(texts, maxWidth, sizes.map((s) => s * u), measureWith(ctx, weight));
}

export function newLayer(width: number, height: number): { canvas: Canvas; ctx: SKRSContext2D } {
	const canvas = createCanvas(width, height);
	return { canvas, ctx: canvas.getContext("2d") };
}

function roundedRect(ctx: SKRSContext2D, x: number, y: number, w: number, h: number, r: number) {
	ctx.beginPath();
	ctx.moveTo(x + r, y);
	ctx.arcTo(x + w, y, x + w, y + h, r);
	ctx.arcTo(x + w, y + h, x, y + h, r);
	ctx.arcTo(x, y + h, x, y, r);
	ctx.arcTo(x, y, x + w, y, r);
	ctx.closePath();
}

/** The cover in a rounded square, with a soft shadow; a tinted square when there is no cover. */
export function drawCover(ctx: SKRSContext2D, cover: Image | null, x: number, y: number, size: number, radius: number, fallback: string) {
	ctx.save();
	ctx.shadowColor = "rgba(0,0,0,0.45)";
	ctx.shadowBlur = size * 0.08;
	ctx.shadowOffsetY = size * 0.03;
	roundedRect(ctx, x, y, size, size, radius);
	ctx.fillStyle = fallback;
	ctx.fill();
	ctx.restore();
	if (!cover) return;
	ctx.save();
	roundedRect(ctx, x, y, size, size, radius);
	ctx.clip();
	ctx.drawImage(cover, x, y, size, size);
	ctx.restore();
}

/** The cover scaled to fill the whole frame, blurred. */
export function drawCoverFill(ctx: SKRSContext2D, cover: Image, width: number, height: number, blur: number) {
	const s = Math.max(width / cover.width, height / cover.height) * 1.25;
	ctx.save();
	ctx.filter = `blur(${Math.round(blur)}px)`;
	ctx.drawImage(cover, (width - cover.width * s) / 2, (height - cover.height * s) / 2, cover.width * s, cover.height * s);
	ctx.restore();
}

/** Title over artist, each cut to one row. */
export function drawMeta(
	ctx: SKRSContext2D,
	opts: { title: string; artist: string; x: number; y: number; maxWidth: number; size: number; align: CanvasTextAlign; color: string; dim: string },
) {
	const { title, artist, x, y, maxWidth, size, align, color, dim } = opts;
	const measure = measureWith(ctx, 700);
	ctx.textAlign = align;
	ctx.textBaseline = "alphabetic";
	ctx.fillStyle = color;
	ctx.font = font(size, 700);
	ctx.fillText(ellipsize(title, maxWidth, size, measure), x, y);
	ctx.fillStyle = dim;
	ctx.font = font(size * 0.8, 600);
	ctx.fillText(ellipsize(artist, maxWidth, size * 0.8, measureWith(ctx, 600)), x, y + size * 1.25);
}

/** The small "Wavelet" mark. */
export function drawWatermark(ctx: SKRSContext2D, x: number, y: number, size: number, color: string, align: CanvasTextAlign = "center") {
	ctx.textAlign = align;
	ctx.textBaseline = "alphabetic";
	ctx.fillStyle = color;
	ctx.font = font(size, 700);
	ctx.fillText("Wavelet", x, y);
}

export interface LyricsStyle {
	x: number;
	/** Where the current line's first row sits. */
	anchorY: number;
	align: CanvasTextAlign;
	weight: 600 | 700;
	/** Row height as a multiple of the font size. */
	leading: number;
	/** Space between two lines, as a multiple of the font size. */
	gap: number;
	active: string;
	/** Colour of the other lines; their alpha comes from `idleAlpha`. */
	idle: string;
	idleAlpha: number;
	/** Lines drawn above and below the current one. */
	above: number;
	below: number;
	/** Lines fade out over this distance from the anchor (px). */
	fadeDistance: number;
}

/** Top of each line (px, from the first line's top) for a layout. */
function lineTops(layout: LyricsLayout, style: LyricsStyle): number[] {
	const row = layout.fontSize * style.leading;
	const tops: number[] = [];
	let y = 0;
	for (const rows of layout.rows) {
		tops.push(y);
		y += rows.length * row + layout.fontSize * style.gap;
	}
	return tops;
}

/**
 * The lyrics around the current line: it scrolls into place and brightens as it comes in, the
 * previous one dims, the others stay faint and fade with the distance from the anchor.
 */
export function drawLyrics(ctx: SKRSContext2D, layout: LyricsLayout, state: TimelineState, style: LyricsStyle) {
	const tops = lineTops(layout, style);
	const lo = Math.floor(state.scroll);
	const hi = Math.min(tops.length - 1, lo + 1);
	const offset = tops[lo] + (tops[hi] - tops[lo]) * (state.scroll - lo);
	const row = layout.fontSize * style.leading;

	ctx.textAlign = style.align;
	ctx.textBaseline = "top";
	ctx.font = font(layout.fontSize, style.weight);
	const first = Math.max(0, state.active - style.above);
	const last = Math.min(layout.rows.length - 1, state.active + style.below);
	for (let i = first; i <= last; i++) {
		const y = style.anchorY + tops[i] - offset;
		let alpha = style.idleAlpha;
		if (i === state.active) alpha = style.idleAlpha + (1 - style.idleAlpha) * state.enter;
		else if (i === state.active - 1) alpha = 1 - (1 - style.idleAlpha) * state.enter;
		const distance = Math.abs(y - style.anchorY);
		alpha *= Math.max(0, 1 - Math.max(0, distance - row) / style.fadeDistance);
		if (alpha <= 0.01) continue;
		ctx.globalAlpha = alpha;
		ctx.fillStyle = i === state.active || i === state.active - 1 ? style.active : style.idle;
		layout.rows[i].forEach((text, k) => ctx.fillText(text, style.x, y + k * row));
	}
	ctx.globalAlpha = 1;
}
