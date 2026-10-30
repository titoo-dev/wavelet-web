import { describe, it, expect } from "vitest";
import {
	DEFAULT_SOUND,
	EQ_BANDS,
	EQ_PRESETS,
	crossfeedFor,
	dbToGain,
	eqGains,
	eqPreampDb,
	isEqActive,
	isSoundActive,
	normalizeSound,
	roomFor,
	roomImpulse,
} from "./sound";

describe("sound settings", () => {
	it("are all off by default: the graph stays out of the way", () => {
		expect(isSoundActive(DEFAULT_SOUND)).toBe(false);
		expect(isEqActive(DEFAULT_SOUND)).toBe(false);
	});

	it("falls back to the defaults for anything unknown in storage", () => {
		expect(normalizeSound(undefined)).toEqual(DEFAULT_SOUND);
		expect(normalizeSound("x")).toEqual(DEFAULT_SOUND);
		expect(normalizeSound({ spatial: "cathedral", eqPreset: "metal", eqCustom: "no" })).toEqual(DEFAULT_SOUND);
	});

	it("pads a short custom curve, clamps it to ±12 dB in half steps, and drops non-numbers", () => {
		const s = normalizeSound({ spatial: "room", eqPreset: "custom", eqCustom: [20, -30, 3.3, "x", NaN] });
		expect(s.spatial).toBe("room");
		expect(s.eqCustom).toEqual([12, -12, 3.5, 0, 0, 0, 0, 0, 0, 0]);
	});

	it("uses the preset's curve, the custom one only for custom", () => {
		const custom = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
		expect(eqGains({ spatial: "off", eqPreset: "bass", eqCustom: custom })).toEqual(EQ_PRESETS.bass);
		expect(eqGains({ spatial: "off", eqPreset: "custom", eqCustom: custom })).toEqual(custom);
	});

	it("is active as soon as spatial sound is on or the curve is not flat", () => {
		expect(isSoundActive({ ...DEFAULT_SOUND, spatial: "studio" })).toBe(true);
		expect(isSoundActive({ ...DEFAULT_SOUND, eqPreset: "vocal" })).toBe(true);
		expect(isSoundActive({ ...DEFAULT_SOUND, eqPreset: "custom", eqCustom: EQ_BANDS.map(() => 0) })).toBe(false);
	});

	it("every preset has one gain per band", () => {
		for (const curve of Object.values(EQ_PRESETS)) expect(curve).toHaveLength(EQ_BANDS.length);
	});
});

describe("equaliser headroom", () => {
	it("lowers the input by the highest boost, never raises it", () => {
		expect(eqPreampDb([6, 5, 4, 2, 0, 0, 0, 0, 0, 0])).toBe(-6);
		expect(eqPreampDb([-3, -2, 0])).toBe(-0);
		expect(dbToGain(-6)).toBeCloseTo(0.501, 3);
	});
});

describe("crossfeed", () => {
	it("is off with spatial sound off", () => {
		expect(crossfeedFor("off")).toBeNull();
	});

	it("keeps a centred bass at unity and the direct treble where it was", () => {
		for (const mode of ["studio", "room", "hall"] as const) {
			const cf = crossfeedFor(mode)!;
			// Low frequencies of a mono source: direct + fed ≈ 1.
			expect(cf.makeup * (1 + cf.feed)).toBeCloseTo(1, 6);
			// High frequencies: only the shelved direct path, ≈ 1.
			expect(cf.makeup * dbToGain(cf.shelfDb)).toBeCloseTo(1, 6);
			expect(cf.delayS).toBeGreaterThan(0);
			expect(cf.delayS).toBeLessThan(0.001);
		}
	});

	it("feeds more of the other ear as the space grows", () => {
		expect(crossfeedFor("studio")!.feed).toBeLessThan(crossfeedFor("room")!.feed);
		expect(crossfeedFor("room")!.feed).toBeLessThan(crossfeedFor("hall")!.feed);
	});
});

describe("room", () => {
	it("exists for room and hall only, the hall longer and wetter", () => {
		expect(roomFor("off")).toBeNull();
		expect(roomFor("studio")).toBeNull();
		const room = roomFor("room")!;
		const hall = roomFor("hall")!;
		expect(hall.decayS).toBeGreaterThan(room.decayS);
		expect(hall.wet).toBeGreaterThan(room.wet);
	});

	it("builds a stereo impulse: silent pre-delay, decaying tail, different left and right", () => {
		const p = roomFor("room")!;
		const rate = 8000;
		const [l, r] = roomImpulse(p, rate);
		expect(l.length).toBe(Math.round((p.preDelayS + p.decayS) * rate));
		const pre = Math.round(p.preDelayS * rate);
		expect(l.slice(0, pre).every((v) => v === 0)).toBe(true);
		const energy = (a: Float32Array, from: number, to: number) => a.slice(from, to).reduce((s, v) => s + v * v, 0);
		const quarter = Math.floor((l.length - pre) / 4);
		expect(energy(l, pre, pre + quarter)).toBeGreaterThan(100 * energy(l, l.length - quarter, l.length));
		expect(Array.from(l)).not.toEqual(Array.from(r));
	});

	it("is the same on every build (seeded noise)", () => {
		const p = roomFor("hall")!;
		expect(Array.from(roomImpulse(p, 4000)[0])).toEqual(Array.from(roomImpulse(p, 4000)[0]));
	});
});
