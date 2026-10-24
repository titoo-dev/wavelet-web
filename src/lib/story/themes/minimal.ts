// Minimal: black, Geist, centred lyrics, a small cover with the title at the bottom.
import { timelineAt } from "../timeline";
import { drawCover, drawLyrics, drawMeta, drawWatermark, layoutFor, newLayer, unitOf } from "./common";
import type { StoryTheme } from "./types";

export const minimal: StoryTheme = {
	id: "minimal",
	prepare(input) {
		const { width, height, cover } = input;
		const u = unitOf(width);
		const { canvas, ctx } = newLayer(width, height);
		ctx.fillStyle = "#000000";
		ctx.fillRect(0, 0, width, height);
		// Hairline above the footer, as in the app's Geist base.
		ctx.fillStyle = "rgba(255,255,255,0.14)";
		ctx.fillRect(80 * u, height - 330 * u, width - 160 * u, Math.max(1, 2 * u));

		const size = 120 * u;
		const x = 80 * u;
		const y = height - 280 * u;
		drawCover(ctx, cover, x, y, size, 14 * u, "#1a1a1a");
		drawMeta(ctx, {
			title: input.title,
			artist: input.artist,
			x: x + size + 32 * u,
			y: y + size / 2 - 4 * u,
			maxWidth: width - x - size - 32 * u - 80 * u,
			size: 36 * u,
			align: "left",
			color: "#ededed",
			dim: "#8f8f8f",
		});
		drawWatermark(ctx, width - 80 * u, 150 * u, 28 * u, "#5f5f5f", "right");
		const layout = layoutFor(ctx, input.range.lines.map((l) => l.text), width - 180 * u, [62, 54, 46], u, 600);
		return { input, background: canvas, layout };
	},
	draw(ctx, story, tMs) {
		const { width } = story.input;
		const u = unitOf(width);
		ctx.drawImage(story.background, 0, 0);
		drawLyrics(ctx, story.layout, timelineAt(story.input.range, tMs), {
			x: width / 2,
			anchorY: 760 * u,
			align: "center",
			weight: 600,
			leading: 1.2,
			gap: 0.7,
			active: "#ededed",
			idle: "#ededed",
			idleAlpha: 0.28,
			above: 2,
			below: 3,
			fadeDistance: 520 * u,
		});
	},
};
