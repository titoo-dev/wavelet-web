import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
	NORM_MAX_GAIN,
	__setAudioContextFactory,
	getAnalyser,
	getElementVolume,
	initAudioCtx,
	installGestureUnlock,
	isAudioCtxRunning,
	isRouted,
	readLevel,
	releaseElement,
	resetNormGain,
	routeElement,
	setElementVolume,
	setNormGain,
	setSoundEffects,
	isSoundChainActive,
} from "./audio-context";
import { adjustVolume } from "./adjust-volume";
import { DEFAULT_SOUND } from "@/components/audio/engine/sound";
import { soundNodeFactories, type GraphNode, type SoundNodeFactories } from "@/test/helpers/fake-audio-graph";

class FakeNode {
	outputs: FakeNode[] = [];
	disconnected = false;
	connect(node: FakeNode) {
		this.outputs.push(node);
		return node;
	}
	disconnect() {
		this.disconnected = true;
		this.outputs = [];
	}
}

class FakeGain extends FakeNode {
	gain = {
		value: 1,
		setTargetAtTime: vi.fn((v: number) => {
			this.gain.value = v;
		}),
	};
}

class FakeAnalyser extends FakeNode {
	fftSize = 2048;
	smoothingTimeConstant = 0;
	samples: number[] = [];
	getFloatTimeDomainData(buf: Float32Array) {
		for (let i = 0; i < buf.length; i++) buf[i] = this.samples[i % (this.samples.length || 1)] ?? 0;
	}
}

class FakeContext {
	state: AudioContextState = "suspended";
	currentTime = 0;
	destination = new FakeNode();
	sources = new Map<HTMLAudioElement, FakeNode>();
	gains: FakeGain[] = [];
	analysers: FakeAnalyser[] = [];
	// Like browsers, the state only changes once resume() settles.
	resume = vi.fn(() =>
		Promise.resolve().then(() => {
			this.state = "running";
		})
	);
	createAnalyser() {
		const a = new FakeAnalyser();
		this.analysers.push(a);
		return a;
	}
	createGain() {
		const g = new FakeGain();
		this.gains.push(g);
		return g;
	}
	createMediaElementSource(el: HTMLAudioElement) {
		if (this.sources.has(el)) throw new DOMException("already connected", "InvalidStateError");
		const node = new FakeNode();
		this.sources.set(el, node);
		return node;
	}
}

let ctx: FakeContext;
let created: number;

function useFakeContext() {
	created = 0;
	ctx = new FakeContext();
	__setAudioContextFactory(() => {
		created++;
		return ctx as unknown as AudioContext;
	});
}

async function running() {
	initAudioCtx();
	await Promise.resolve();
	expect(isAudioCtxRunning()).toBe(true);
}

/** An element whose volume is read-only, like iOS Safari. */
function iosAudio() {
	const audio = new Audio();
	Object.defineProperty(audio, "volume", { get: () => 1, set: () => {}, configurable: true });
	return audio;
}

beforeEach(() => useFakeContext());
afterEach(() => __setAudioContextFactory());

describe("AudioContext lifecycle", () => {
	it("is created and resumed by a click once something plays (was: created on a timeupdate, outside any gesture)", async () => {
		let playing = false;
		const remove = installGestureUnlock(() => playing);
		document.body.click();
		expect(created).toBe(0);
		playing = true;
		document.body.click();
		expect(created).toBe(1);
		expect(ctx.resume).toHaveBeenCalled();
		await Promise.resolve();
		expect(isAudioCtxRunning()).toBe(true);
		remove();
	});

	it("resumes a suspended context on the next tap", async () => {
		await running();
		ctx.state = "suspended";
		const remove = installGestureUnlock(() => false);
		document.dispatchEvent(new Event("touchend"));
		expect(ctx.resume).toHaveBeenCalledTimes(2);
		remove();
	});

	it("tries to get a context the system suspended back (a routed element would stay silent)", async () => {
		await running();
		ctx.state = "suspended";
		(ctx as unknown as { onstatechange: () => void }).onstatechange();
		await Promise.resolve();
		expect(isAudioCtxRunning()).toBe(true);
	});

	it("degrades to nothing without Web Audio", () => {
		__setAudioContextFactory(() => null);
		expect(initAudioCtx()).toBe(false);
		expect(getAnalyser()).toBeNull();
		expect(routeElement(new Audio())).toBe(false);
	});
});

describe("routing and volume", () => {
	it("never routes an element into a suspended context (was: silence)", () => {
		initAudioCtx(); // resume() not settled yet: still suspended
		const audio = new Audio();
		expect(routeElement(audio)).toBe(false);
		setElementVolume(audio, 0.4);
		expect(audio.volume).toBeCloseTo(0.4);
	});

	it("finishes on time when the browser throttles its timer (was: a pause from another Device took ~40 s in a background tab)", async () => {
		const audio = new Audio();
		setElementVolume(audio, 0.8);
		vi.useFakeTimers();
		const realSetInterval = globalThis.setInterval;
		// A hidden, silent tab runs intervals at most once a second.
		const spy = vi
			.spyOn(globalThis, "setInterval")
			.mockImplementation(((fn: () => void) => realSetInterval(fn, 1000)) as typeof setInterval);
		try {
			let done = false;
			const fade = adjustVolume(audio, 0, { duration: 500 }).then(() => (done = true));
			await vi.advanceTimersByTimeAsync(1000);
			expect(done).toBe(true);
			expect(audio.volume).toBe(0);
			await fade;
		} finally {
			spy.mockRestore();
			vi.useRealTimers();
		}
	});

	it("fades from the element's real volume when something else set element.volume (was: a preview started after a stop skipped its fade-in)", async () => {
		const audio = new Audio();
		setElementVolume(audio, 0.8);
		audio.volume = 0; // AudioPreview mutes its element this way before play()
		expect(getElementVolume(audio)).toBe(0);
		vi.useFakeTimers();
		try {
			const done = adjustVolume(audio, 0.8, { duration: 130 });
			vi.advanceTimersByTime(65);
			expect(audio.volume).toBeGreaterThan(0);
			expect(audio.volume).toBeLessThan(0.8);
			vi.advanceTimersByTime(100);
			await done;
			expect(audio.volume).toBeCloseTo(0.8);
		} finally {
			vi.useRealTimers();
		}
	});

	it("drives a routed element's volume through its own GainNode, element.volume stays 1 (was: read-only on iOS)", async () => {
		await running();
		const audio = new Audio();
		setElementVolume(audio, 0.3);
		expect(routeElement(audio)).toBe(true);
		const volumeNode = ctx.gains.at(-1)!;
		expect(volumeNode.gain.value).toBeCloseTo(0.3);
		expect(audio.volume).toBe(1);
		setElementVolume(audio, 0.8);
		expect(volumeNode.gain.value).toBeCloseTo(0.8);
		expect(getElementVolume(audio)).toBeCloseTo(0.8);
	});

	it("keeps the volume asked on a read-only element and hands it to the GainNode once routed (iOS)", async () => {
		const audio = iosAudio();
		setElementVolume(audio, 0.25);
		expect(getElementVolume(audio)).toBe(0.25);
		await running();
		routeElement(audio);
		expect(ctx.gains.at(-1)!.gain.value).toBe(0.25);
	});

	it("fades a routed element through its GainNode", async () => {
		await running();
		const audio = iosAudio();
		routeElement(audio);
		setElementVolume(audio, 0);
		vi.useFakeTimers();
		try {
			const done = adjustVolume(audio, 1, { duration: 130 });
			vi.advanceTimersByTime(65);
			const mid = ctx.gains.at(-1)!.gain.value;
			expect(mid).toBeGreaterThan(0);
			expect(mid).toBeLessThan(1);
			vi.advanceTimersByTime(100);
			await done;
			expect(ctx.gains.at(-1)!.gain.value).toBe(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it("gives every element its own nodes and disconnects them on release (was: a source per element, never disconnected)", async () => {
		await running();
		const a = new Audio();
		const b = new Audio();
		routeElement(a);
		routeElement(b);
		expect(ctx.sources.size).toBe(2);
		releaseElement(a);
		expect(ctx.sources.get(a)!.disconnected).toBe(true);
		expect(isRouted(a)).toBe(false);
		expect(isRouted(b)).toBe(true);
		expect(routeElement(b)).toBe(true); // idempotent: no second source
		expect(ctx.sources.size).toBe(2);
	});

	it("doesn't retry an element the context refused", async () => {
		await running();
		const audio = new Audio();
		ctx.sources.set(audio, new FakeNode()); // e.g. connected by someone else
		expect(routeElement(audio)).toBe(false);
		expect(routeElement(audio)).toBe(false);
	});
});

describe("per-element normalisation", () => {
	it("measures and sets the gain of one element only; a new element starts at unity (was: the previous track's gain carried over)", async () => {
		await running();
		const a = new Audio();
		const b = new Audio();
		routeElement(a);
		const meterA = ctx.analysers.at(-1)!;
		const normA = ctx.gains.at(-2)!;
		meterA.samples = [0.5, -0.5];
		expect(readLevel(a)).toEqual({ rms: 0.5, peak: 0.5 });

		setNormGain(a, 10);
		expect(normA.gain.value).toBe(NORM_MAX_GAIN);
		routeElement(b);
		expect(ctx.gains.at(-2)!.gain.value).toBe(1);

		resetNormGain(a);
		expect(normA.gain.value).toBe(1);
		expect(readLevel(new Audio())).toBeNull();
	});
});

describe("sound effects", () => {
	/** The fake context with the node types the effects need. */
	function withSoundNodes() {
		// Keep the fake context's own gains (tracked in ctx.gains).
		Object.assign(ctx, { ...soundNodeFactories(48000), createGain: ctx.createGain.bind(ctx) });
	}

	it("routes elements through a bus that feeds the analyser directly while every effect is off", async () => {
		await running();
		const audio = new Audio();
		routeElement(audio);
		const volume = ctx.gains.at(-1)!;
		const bus = volume.outputs[0] as FakeGain;
		expect(bus).toBeInstanceOf(FakeGain);
		expect(bus.outputs).toEqual([getAnalyser()]);
		expect(isSoundChainActive()).toBe(false);
	});

	it("applies settings chosen before the context exists once it is created", async () => {
		withSoundNodes();
		setSoundEffects({ ...DEFAULT_SOUND, spatial: "studio" });
		expect(isSoundChainActive()).toBe(false);
		await running();
		expect(isSoundChainActive()).toBe(true);
	});

	it("puts the chain between the bus and the analyser, and takes it out again when turned off", async () => {
		withSoundNodes();
		await running();
		const audio = new Audio();
		routeElement(audio);
		const bus = ctx.gains.at(-1)!.outputs[0] as FakeGain;

		setSoundEffects({ ...DEFAULT_SOUND, eqPreset: "bass" });
		expect(isSoundChainActive()).toBe(true);
		const input = bus.outputs[0] as unknown as GraphNode;
		expect(input).not.toBe(getAnalyser());
		const limiter = (ctx as unknown as SoundNodeFactories).made.find((n) => n.kind === "compressor")!;
		expect(limiter.next).toEqual([getAnalyser()]);

		setSoundEffects(DEFAULT_SOUND);
		expect(isSoundChainActive()).toBe(false);
		expect(bus.outputs).toEqual([getAnalyser()]);
		expect(limiter.disconnected).toBe(true);
	});

	it("disconnects the previous chain when the settings change", async () => {
		withSoundNodes();
		await running();
		setSoundEffects({ ...DEFAULT_SOUND, spatial: "room" });
		const first = (ctx as unknown as SoundNodeFactories).made.slice();
		setSoundEffects({ ...DEFAULT_SOUND, spatial: "hall" });
		expect(first.every((n) => n.disconnected)).toBe(true);
		expect(isSoundChainActive()).toBe(true);
	});

	it("leaves the sound untouched when the browser lacks a node type", async () => {
		await running(); // the plain fake context: no biquad, no convolver
		const audio = new Audio();
		routeElement(audio);
		const bus = ctx.gains.at(-1)!.outputs[0] as FakeGain;
		setSoundEffects({ ...DEFAULT_SOUND, spatial: "hall", eqPreset: "vocal" });
		expect(isSoundChainActive()).toBe(false);
		expect(bus.outputs).toEqual([getAnalyser()]);
	});
});
