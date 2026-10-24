// Palette: a gradient built from the cover's seed colour (the CoverTheme seed), big left-aligned
// lyrics, a small cover with the title in the top corner.
import { oklch } from "../color";
import { timelineAt } from "../timeline";
import { drawCover, drawLyrics, drawMeta, drawWatermark, layoutFor, newLayer, unitOf } from "./common";
import type { StoryTheme } from "./types";

export const palette: StoryTheme = {
	id: "palette",
	prepare(input) {
		const { width, height, cover, seed } = input;
		const u = unitOf(width);
		const c = Math.max(0.03, 0.14 * seed.chroma);
		const { canvas, ctx } = newLayer(width, height);
		const g = ctx.createLinearGradient(0, 0, width * 0.4, height);
		g.addColorStop(0, oklch(0.58, c, seed.hue));
		g.addColorStop(0.55, oklch(0.36, c * 0.9, (seed.hue + 20) % 360));
		g.addColorStop(1, oklch(0.16, c * 0.5, (seed.hue + 40) % 360));
		ctx.fillStyle = g;
		ctx.fillRect(0, 0, width, height);
		// A soft glow behind the lyrics.
		const glow = ctx.createRadialGradient(width * 0.3, height * 0.55, 0, width * 0.3, height * 0.55, width * 0.9);
		glow.addColorStop(0, oklch(0.75, c, (seed.hue + 340) % 360, 0.35));
		glow.addColorStop(1, oklch(0.75, c, (seed.hue + 340) % 360, 0));
		ctx.fillStyle = glow;
		ctx.fillRect(0, 0, width, height);

		const size = 150 * u;
		const x = 80 * u;
		drawCover(ctx, cover, x, 150 * u, size, 22 * u, oklch(0.45, c, seed.hue));
		drawMeta(ctx, {
			title: input.title,
			artist: input.artist,
			x: x + size + 36 * u,
			y: 150 * u + size / 2 - 6 * u,
			maxWidth: width - x - size - 36 * u - 80 * u,
			size: 40 * u,
			align: "left",
			color: "#ffffff",
			dim: "rgba(255,255,255,0.75)",
		});
		drawWatermark(ctx, x, height - 80 * u, 30 * u, "rgba(255,255,255,0.6)", "left");
		const layout = layoutFor(ctx, input.range.lines.map((l) => l.text), width - 160 * u, [92, 78, 66, 56], u, 700);
		return { input, background: canvas, layout };
	},
	draw(ctx, story, tMs) {
		const { width } = story.input;
		const u = unitOf(width);
		ctx.drawImage(story.background, 0, 0);
		drawLyrics(ctx, story.layout, timelineAt(story.input.range, tMs), {
			x: 80 * u,
			anchorY: 760 * u,
			align: "left",
			weight: 700,
			leading: 1.08,
			gap: 0.45,
			active: "#ffffff",
			idle: "#ffffff",
			idleAlpha: 0.3,
			above: 1,
			below: 4,
			fadeDistance: 700 * u,
		});
	},
};
