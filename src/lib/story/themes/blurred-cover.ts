// Blurred Cover: the cover blurred and darkened fills the frame, the sharp cover sits on top,
// the lyrics below it.
import { oklch } from "../color";
import { timelineAt } from "../timeline";
import { drawCover, drawCoverFill, drawLyrics, drawMeta, drawWatermark, layoutFor, newLayer, unitOf } from "./common";
import type { StoryTheme } from "./types";

export const blurredCover: StoryTheme = {
	id: "blurred-cover",
	prepare(input) {
		const { width, height, cover, seed } = input;
		const u = unitOf(width);
		const { canvas, ctx } = newLayer(width, height);
		if (cover) {
			drawCoverFill(ctx, cover, width, height, 70 * u);
			ctx.fillStyle = "rgba(0,0,0,0.5)";
			ctx.fillRect(0, 0, width, height);
		} else {
			const g = ctx.createLinearGradient(0, 0, 0, height);
			g.addColorStop(0, oklch(0.32, 0.1 * seed.chroma, seed.hue));
			g.addColorStop(1, oklch(0.12, 0.04 * seed.chroma, seed.hue));
			ctx.fillStyle = g;
			ctx.fillRect(0, 0, width, height);
		}
		const size = 560 * u;
		drawCover(ctx, cover, (width - size) / 2, 170 * u, size, 36 * u, oklch(0.4, 0.1 * seed.chroma, seed.hue));
		drawMeta(ctx, {
			title: input.title,
			artist: input.artist,
			x: width / 2,
			y: 170 * u + size + 90 * u,
			maxWidth: width - 160 * u,
			size: 44 * u,
			align: "center",
			color: "#ffffff",
			dim: "rgba(255,255,255,0.7)",
		});
		drawWatermark(ctx, width / 2, height - 70 * u, 28 * u, "rgba(255,255,255,0.55)");
		const layout = layoutFor(ctx, input.range.lines.map((l) => l.text), width - 140 * u, [68, 58, 50], u, 700);
		return { input, background: canvas, layout };
	},
	draw(ctx, story, tMs) {
		const { width } = story.input;
		const u = unitOf(width);
		ctx.drawImage(story.background, 0, 0);
		drawLyrics(ctx, story.layout, timelineAt(story.input.range, tMs), {
			x: width / 2,
			anchorY: 1130 * u,
			align: "center",
			weight: 700,
			leading: 1.18,
			gap: 0.55,
			active: "#ffffff",
			idle: "#ffffff",
			idleAlpha: 0.35,
			above: 1,
			below: 3,
			fadeDistance: 520 * u,
		});
	},
};
