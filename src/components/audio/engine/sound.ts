// Sound effects of the player: headphone spatialisation and a 10-band
// equaliser. Pure settings and maths here; the Web Audio graph that applies
// them is utils/sound-graph.ts. Everything off = the graph is bypassed and the
// file plays bit for bit as decoded.

/** Headphone spatialisation: crossfeed, then a synthetic room for `room` / `hall`. */
export type SpatialMode = "off" | "studio" | "room" | "hall";

export const SPATIAL_MODES: readonly SpatialMode[] = ["off", "studio", "room", "hall"];

export type EqPresetId = "flat" | "bass" | "vocal" | "acoustic" | "bright" | "loudness" | "custom";

/** Band centres in Hz: a low shelf, eight peaks, a high shelf. */
export const EQ_BANDS = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000] as const;

/** A band never moves by more than ±12 dB. */
export const EQ_MAX_DB = 12;

export const EQ_PRESETS: Record<Exclude<EqPresetId, "custom">, readonly number[]> = {
	flat: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
	bass: [6, 5, 4, 2, 0, 0, 0, 0, 0, 0],
	vocal: [-2, -2, -1, 0, 2, 3, 3, 2, 0, -1],
	acoustic: [3, 3, 2, 1, 1, 1, 2, 2, 2, 1],
	bright: [0, 0, 0, 0, 0, 1, 2, 3, 4, 4],
	loudness: [4, 3, 1, 0, -1, -1, 0, 1, 3, 4],
};

export const EQ_PRESET_IDS: readonly EqPresetId[] = ["flat", "bass", "vocal", "acoustic", "bright", "loudness", "custom"];

export interface SoundSettings {
	spatial: SpatialMode;
	eqPreset: EqPresetId;
	/** The custom curve (dB per band); presets use their own. */
	eqCustom: number[];
}

export const DEFAULT_SOUND: SoundSettings = { spatial: "off", eqPreset: "flat", eqCustom: [...EQ_PRESETS.flat] };

const clampDb = (v: unknown) => (typeof v === "number" && isFinite(v) ? Math.max(-EQ_MAX_DB, Math.min(EQ_MAX_DB, Math.round(v * 2) / 2)) : 0);

/** Settings read back from storage: unknown values fall back to the defaults. */
export function normalizeSound(raw: unknown): SoundSettings {
	const r = (raw && typeof raw === "object" ? raw : {}) as Partial<Record<keyof SoundSettings, unknown>>;
	const spatial = SPATIAL_MODES.includes(r.spatial as SpatialMode) ? (r.spatial as SpatialMode) : DEFAULT_SOUND.spatial;
	const eqPreset = EQ_PRESET_IDS.includes(r.eqPreset as EqPresetId) ? (r.eqPreset as EqPresetId) : DEFAULT_SOUND.eqPreset;
	const custom = Array.isArray(r.eqCustom) ? r.eqCustom : [];
	return { spatial, eqPreset, eqCustom: EQ_BANDS.map((_, i) => clampDb(custom[i])) };
}

/** The curve in effect (dB per band of EQ_BANDS). */
export function eqGains(s: SoundSettings): number[] {
	return s.eqPreset === "custom" ? EQ_BANDS.map((_, i) => clampDb(s.eqCustom[i])) : [...EQ_PRESETS[s.eqPreset]];
}

export function isEqActive(s: SoundSettings): boolean {
	return eqGains(s).some((g) => g !== 0);
}

/** Whether anything sits between the player and the speakers. */
export function isSoundActive(s: SoundSettings): boolean {
	return s.spatial !== "off" || isEqActive(s);
}

/** Gain ahead of the equaliser so its highest boost cannot clip (dB, ≤ 0). */
export function eqPreampDb(gains: readonly number[]): number {
	return -Math.max(0, ...gains);
}

export const dbToGain = (db: number) => Math.pow(10, db / 20);

export interface CrossfeedParams {
	/** Low-pass corner of the signal fed to the other ear (Hz). */
	cutoffHz: number;
	/** Level of that signal against the direct one (linear). */
	feed: number;
	/** Extra path to the far ear (seconds). */
	delayS: number;
	/** High-shelf boost on the direct path that keeps the treble where it was (dB). */
	shelfDb: number;
	/** Overall gain that keeps a centred bass at its level (linear). */
	makeup: number;
}

export interface RoomParams {
	/** RT60-like decay of the impulse (seconds). */
	decayS: number;
	preDelayS: number;
	/** Level of the reverberant sound against the dry one (linear). */
	wet: number;
	/** Treble damping of the tail: the low-pass corner at its end (Hz). */
	dampHz: number;
}

/**
 * Crossfeed after bs2b: each ear also hears the other channel, low-passed,
 * slightly later and quieter, as with speakers — the sound leaves the head.
 */
export function crossfeedFor(mode: SpatialMode): CrossfeedParams | null {
	if (mode === "off") return null;
	const feedDb = mode === "studio" ? -6 : mode === "room" ? -5 : -4.5;
	const feed = dbToGain(feedDb);
	return { cutoffHz: 700, feed, delayS: 0.00027, shelfDb: 20 * Math.log10(1 + feed), makeup: 1 / (1 + feed) };
}

export function roomFor(mode: SpatialMode): RoomParams | null {
	// Wet levels measured in Chrome on music-like input (the convolver
	// normalises the impulse): the room ≈ −20 dB under the dry sound, the hall ≈ −13 dB.
	if (mode === "room") return { decayS: 0.55, preDelayS: 0.008, wet: 0.56, dampHz: 4500 };
	if (mode === "hall") return { decayS: 1.6, preDelayS: 0.022, wet: 0.6, dampHz: 3000 };
	return null;
}

/** Small deterministic PRNG (mulberry32): the same room on every load. */
function rng(seed: number) {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/**
 * Stereo impulse response of a synthetic room: silence for the pre-delay, a
 * few early reflections, then decorrelated noise decaying by 60 dB over
 * `decayS` and darkening as it goes (a one-pole low-pass closing towards
 * `dampHz`). Left and right differ, which is what widens the image.
 */
export function roomImpulse(p: RoomParams, sampleRate: number): [Float32Array<ArrayBuffer>, Float32Array<ArrayBuffer>] {
	const length = Math.max(1, Math.round((p.preDelayS + p.decayS) * sampleRate));
	const pre = Math.round(p.preDelayS * sampleRate);
	const channels: [Float32Array<ArrayBuffer>, Float32Array<ArrayBuffer>] = [new Float32Array(length), new Float32Array(length)];
	const reflections = [0.0043, 0.0071, 0.0113, 0.0167];
	channels.forEach((data, ch) => {
		const next = rng(0x5eed + ch * 7919);
		let lp = 0;
		for (let i = pre; i < length; i++) {
			const t = (i - pre) / sampleRate;
			const env = Math.pow(10, (-3 * t) / p.decayS); // −60 dB at decayS
			const corner = 18000 - (18000 - p.dampHz) * Math.min(1, t / p.decayS);
			const k = 1 - Math.exp((-2 * Math.PI * corner) / sampleRate);
			lp += k * (next() * 2 - 1 - lp);
			data[i] = lp * env;
		}
		reflections.forEach((d, j) => {
			const at = pre + Math.round((d + ch * 0.0009 * (j + 1)) * sampleRate);
			if (at < length) data[at] += 0.5 * Math.pow(0.7, j) * (j % 2 ? -1 : 1);
		});
	});
	return channels;
}
