// OKLCH → CSS rgb() for the canvas, so Story Themes can build colours from the cover seed
// (lib/cover-palette.ts) the same way `.cover-theme` does in CSS.

const toSrgb = (x: number) => {
	const v = x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055;
	return Math.round(Math.min(1, Math.max(0, v)) * 255);
};

/** OKLCH (lightness 0–1, chroma ≈0–0.37, hue in degrees) → [r, g, b], 0–255, clipped to sRGB. */
export function oklchToRgb(l: number, c: number, h: number): [number, number, number] {
	const rad = (h * Math.PI) / 180;
	const a = c * Math.cos(rad);
	const b = c * Math.sin(rad);
	const l_ = Math.pow(l + 0.3963377774 * a + 0.2158037573 * b, 3);
	const m_ = Math.pow(l - 0.1055613458 * a - 0.0638541728 * b, 3);
	const s_ = Math.pow(l - 0.0894841775 * a - 1.291485548 * b, 3);
	return [
		toSrgb(4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_),
		toSrgb(-1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_),
		toSrgb(-0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_),
	];
}

/** `rgb(r g b / alpha)` of an OKLCH colour. */
export function oklch(l: number, c: number, h: number, alpha = 1): string {
	const [r, g, b] = oklchToRgb(l, c, h);
	return alpha >= 1 ? `rgb(${r} ${g} ${b})` : `rgb(${r} ${g} ${b} / ${alpha})`;
}
