// Vinyl: the cover as the label of a record spinning at 33⅓ rpm, the lyrics underneath.
import { createCanvas, type Canvas } from "@napi-rs/canvas";
import { oklch } from "../color";
import { timelineAt } from "../timeline";
import { drawLyrics, drawMeta, drawWatermark, layoutFor, newLayer, unitOf } from "./common";
import type { PreparedStory, StoryTheme } from "./types";

/** Radians per ms at 33⅓ rpm. */
const SPIN = ((100 / 3) * 2 * Math.PI) / 60_000;

interface VinylStory extends PreparedStory {
	/** The record (grooves + cover label), drawn once and rotated per frame. */
	record: Canvas;
}

export const vinyl: StoryTheme = {
	id: "vinyl",
	prepare(input) {
		const { width, height, cover, seed } = input;
		const u = unitOf(width);
		const c = Math.max(0.02, 0.08 * seed.chroma);
		const { canvas, ctx } = newLayer(width, height);
		const g = ctx.createLinearGradient(0, 0, 0, height);
		g.addColorStop(0, oklch(0.24, c, seed.hue));
		g.addColorStop(1, oklch(0.1, c * 0.6, seed.hue));
		ctx.fillStyle = g;
		ctx.fillRect(0, 0, width, height);
		drawMeta(ctx, {
			title: input.title,
			artist: input.artist,
			x: width / 2,
			y: 170 * u,
			maxWidth: width - 160 * u,
			size: 44 * u,
			align: "center",
			color: "#ffffff",
			dim: "rgba(255,255,255,0.7)",
		});
		drawWatermark(ctx, width / 2, height - 70 * u, 28 * u, "rgba(255,255,255,0.5)");

		const r = 390 * u;
		const record = createCanvas(Math.ceil(r * 2), Math.ceil(r * 2));
		const rc = record.getContext("2d");
		rc.translate(r, r);
		rc.fillStyle = "#0b0b0c";
		rc.beginPath();
		rc.arc(0, 0, r, 0, Math.PI * 2);
		rc.fill();
		rc.strokeStyle = "rgba(255,255,255,0.06)";
		rc.lineWidth = Math.max(1, 1.5 * u);
		for (let gr = r * 0.42; gr < r * 0.97; gr += 9 * u) {
			rc.beginPath();
			rc.arc(0, 0, gr, 0, Math.PI * 2);
			rc.stroke();
		}
		// A sheen that turns with the record, so the spin shows.
		const sheen = rc.createLinearGradient(-r, -r, r, r);
		sheen.addColorStop(0.35, "rgba(255,255,255,0)");
		sheen.addColorStop(0.5, "rgba(255,255,255,0.09)");
		sheen.addColorStop(0.65, "rgba(255,255,255,0)");
		rc.fillStyle = sheen;
		rc.beginPath();
		rc.arc(0, 0, r, 0, Math.PI * 2);
		rc.fill();
		const label = r * 0.4;
		rc.save();
		rc.beginPath();
		rc.arc(0, 0, label, 0, Math.PI * 2);
		rc.clip();
		if (cover) rc.drawImage(cover, -label, -label, label * 2, label * 2);
		else {
			rc.fillStyle = oklch(0.55, Math.max(0.05, 0.14 * seed.chroma), seed.hue);
			rc.fillRect(-label, -label, label * 2, label * 2);
		}
		rc.restore();
		rc.fillStyle = "#0b0b0c";
		rc.beginPath();
		rc.arc(0, 0, 14 * u, 0, Math.PI * 2);
		rc.fill();

		const layout = layoutFor(ctx, input.range.lines.map((l) => l.text), width - 160 * u, [62, 54, 46], u, 700);
		const story: VinylStory = { input, background: canvas, layout, record };
		return story;
	},
	draw(ctx, story, tMs) {
		const { width } = story.input;
		const u = unitOf(width);
		const { record } = story as VinylStory;
		ctx.drawImage(story.background, 0, 0);
		const cx = width / 2;
		const cy = 690 * u;
		ctx.save();
		ctx.shadowColor = "rgba(0,0,0,0.55)";
		ctx.shadowBlur = 60 * u;
		ctx.translate(cx, cy);
		ctx.rotate(tMs * SPIN);
		ctx.drawImage(record, -record.width / 2, -record.height / 2);
		ctx.restore();
		drawLyrics(ctx, story.layout, timelineAt(story.input.range, tMs), {
			x: width / 2,
			anchorY: 1230 * u,
			align: "center",
			weight: 700,
			leading: 1.18,
			gap: 0.55,
			active: "#ffffff",
			idle: "#ffffff",
			idleAlpha: 0.32,
			above: 1,
			below: 2,
			fadeDistance: 420 * u,
		});
	},
};
