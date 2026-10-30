/**
 * Web Audio graph for the player's <audio> elements — shared by AudioEngine,
 * AudioVisualizer and useAudioLevel.
 *
 *   element → MediaElementSource → meter (Analyser) → norm (Gain) → volume (Gain)
 *     → bus (Gain) → [sound effects] → shared Analyser (visualiser) → destination
 *
 * • The AudioContext is created / resumed from a user gesture only
 *   (installGestureUnlock): iOS keeps a context created elsewhere suspended
 *   (was: created on the first timeupdate, outside any gesture).
 * • An element is routed only while the context runs — a routed element
 *   plays nothing through a suspended context. Until then it keeps
 *   element.volume.
 * • A routed element's volume, fades and crossfades go through its own
 *   GainNode: element.volume is read-only on iOS Safari.
 *   setElementVolume / getElementVolume hide the difference.
 * • Loudness normalisation is per element (meter + norm nodes): a new track's
 *   element starts at unity, never with the previous track's gain.
 * • releaseElement() disconnects a discarded element's nodes (was: one
 *   MediaElementSource per element, never disconnected).
 * • Sound effects (sound-graph.ts) sit between the bus and the analyser,
 *   shared by every element, so a crossfade runs through the same chain.
 *   All off = the bus feeds the analyser directly.
 */

import { DEFAULT_SOUND, type SoundSettings } from "@/components/audio/engine/sound";
import { buildSoundChain, type SoundChain } from "./sound-graph";

type AudioContextCtor = new () => AudioContext;

interface Route {
	source: MediaElementAudioSourceNode;
	meter: AnalyserNode;
	norm: GainNode;
	volume: GainNode;
}

/** Normalisation never moves a track by more than ±6 dB. */
export const NORM_MIN_GAIN = 0.5;
export const NORM_MAX_GAIN = 2;

let _ctx: AudioContext | null = null;
let _analyser: AnalyserNode | null = null;
let _bus: GainNode | null = null;
let _sound: SoundSettings = DEFAULT_SOUND;
let _chain: SoundChain | null = null;
let _routes = new WeakMap<HTMLAudioElement, Route>();
let _failed = new WeakSet<HTMLAudioElement>(); // CORS or duplicate-source failures
let _volumes = new WeakMap<HTMLAudioElement, number>();
// element.volume as read back right after our last write to an unrouted
// element (1 on iOS, where it is read-only): tells a write made elsewhere.
let _written = new WeakMap<HTMLAudioElement, number>();

function defaultFactory(): AudioContext | null {
	if (typeof window === "undefined") return null;
	const w = window as unknown as { AudioContext?: AudioContextCtor; webkitAudioContext?: AudioContextCtor };
	const Ctor = w.AudioContext ?? w.webkitAudioContext;
	return Ctor ? new Ctor() : null;
}

let _factory: () => AudioContext | null = defaultFactory;

/** Test seam: swap the AudioContext constructor and forget the current graph. */
export function __setAudioContextFactory(factory?: () => AudioContext | null) {
	_factory = factory ?? defaultFactory;
	_ctx = null;
	_analyser = null;
	_bus = null;
	_sound = DEFAULT_SOUND;
	_chain = null;
	_routes = new WeakMap();
	_failed = new WeakSet();
	_volumes = new WeakMap();
	_written = new WeakMap();
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * Create or resume the AudioContext. Call it from a user gesture: a context
 * created or resumed outside one stays suspended on iOS.
 */
export function initAudioCtx(): boolean {
	if (!_ctx) {
		try {
			_ctx = _factory();
		} catch {
			_ctx = null;
		}
		if (!_ctx) return false;
		_analyser = _ctx.createAnalyser();
		_analyser.fftSize = 256;
		_analyser.smoothingTimeConstant = 0.8;
		_analyser.connect(_ctx.destination);
		_bus = _ctx.createGain();
		applySound();
		// Routed elements play through the context: if the system suspends
		// it (iOS interruption, audio session change) try to get it back.
		const ctx = _ctx;
		ctx.onstatechange = () => {
			if (ctx.state !== "running" && ctx.state !== "closed") ctx.resume().catch(() => {});
		};
	}
	if (_ctx.state !== "running" && _ctx.state !== "closed") _ctx.resume().catch(() => {});
	return _ctx.state !== "closed";
}

export function isAudioCtxRunning(): boolean {
	return _ctx?.state === "running";
}

/**
 * Resume (or create, when `shouldCreate` says playback wants it) the context
 * on every click / tap / key press: those are the gestures iOS and the
 * autoplay policies accept. Listeners sit on the document's bubble phase,
 * after React handled the event — a click that just started a track sees it.
 */
export function installGestureUnlock(shouldCreate: () => boolean = () => true, target: Document = document): () => void {
	const onGesture = () => {
		if (_ctx ? _ctx.state !== "running" : shouldCreate()) initAudioCtx();
	};
	const events = ["click", "keydown", "touchend", "pointerup"] as const;
	for (const type of events) target.addEventListener(type, onGesture, { passive: true });
	return () => {
		for (const type of events) target.removeEventListener(type, onGesture);
	};
}

/**
 * Route an element through the graph — only while the context runs.
 * Idempotent; returns whether the element is routed. Its current volume
 * moves to its GainNode and element.volume stays at 1.
 */
export function routeElement(audio: HTMLAudioElement): boolean {
	if (_routes.has(audio)) return true;
	if (!_ctx || !_bus || _ctx.state !== "running" || _failed.has(audio)) return false;
	try {
		const source = _ctx.createMediaElementSource(audio);
		const meter = _ctx.createAnalyser();
		meter.fftSize = 2048;
		const norm = _ctx.createGain();
		const volume = _ctx.createGain();
		volume.gain.value = getElementVolume(audio);
		source.connect(meter);
		meter.connect(norm);
		norm.connect(volume);
		volume.connect(_bus);
		_routes.set(audio, { source, meter, norm, volume });
		try {
			audio.volume = 1;
		} catch {}
		return true;
	} catch {
		_failed.add(audio);
		return false;
	}
}

export function isRouted(audio: HTMLAudioElement): boolean {
	return _routes.has(audio);
}

/** Disconnect the nodes of an element that is being discarded. */
export function releaseElement(audio: HTMLAudioElement): void {
	const route = _routes.get(audio);
	if (!route) return;
	for (const node of [route.source, route.meter, route.norm, route.volume]) {
		try {
			node.disconnect();
		} catch {}
	}
	_routes.delete(audio);
}

/**
 * The volume the player set on this element (0..1), routed or not. An
 * unrouted element whose element.volume was changed by other code since
 * (AudioPreview mutes its element directly) reports that real volume (was:
 * the stale remembered one, so the next fade-in started at full volume).
 */
export function getElementVolume(audio: HTMLAudioElement): number {
	const remembered = _volumes.get(audio);
	if (remembered === undefined) return audio.volume;
	if (!_routes.has(audio) && _written.has(audio) && audio.volume !== _written.get(audio)) return audio.volume;
	return remembered;
}

/**
 * Set an element's volume: its GainNode when routed (element.volume is
 * read-only on iOS), element.volume otherwise.
 */
export function setElementVolume(audio: HTMLAudioElement, value: number): void {
	const v = clamp(value, 0, 1);
	_volumes.set(audio, v);
	const route = _routes.get(audio);
	if (route) {
		route.volume.gain.value = v;
		return;
	}
	try {
		audio.volume = v;
	} catch {}
	_written.set(audio, audio.volume);
}

/** Returns the shared AnalyserNode (null if not yet initialised). Used by AudioVisualizer. */
export function getAnalyser(): AnalyserNode | null {
	return _analyser;
}

/**
 * RMS and peak of what a routed element plays right now, before
 * normalisation and volume; null when it isn't routed.
 */
export function readLevel(audio: HTMLAudioElement): { rms: number; peak: number } | null {
	const route = _routes.get(audio);
	if (!route) return null;
	const buf = new Float32Array(route.meter.fftSize);
	route.meter.getFloatTimeDomainData(buf);
	let sumSq = 0;
	let peak = 0;
	for (const s of buf) {
		sumSq += s * s;
		const a = Math.abs(s);
		if (a > peak) peak = a;
	}
	return { rms: Math.sqrt(sumSq / buf.length), peak };
}

/** Smoothly set an element's normalisation gain, clamped to ±6 dB. */
export function setNormGain(audio: HTMLAudioElement, gain: number): void {
	const route = _routes.get(audio);
	if (!_ctx || !route) return;
	route.norm.gain.setTargetAtTime(clamp(gain, NORM_MIN_GAIN, NORM_MAX_GAIN), _ctx.currentTime, 0.5);
}

/** Back to unity gain (normalisation turned off). */
export function resetNormGain(audio: HTMLAudioElement | null): void {
	const route = audio ? _routes.get(audio) : undefined;
	if (!_ctx || !route) return;
	route.norm.gain.setTargetAtTime(1, _ctx.currentTime, 0.3);
}

/**
 * Apply the player's sound effects (sound-graph.ts). Remembered until the
 * context exists, rebuilt on every change. A chain that fails to build (a
 * browser without some node type) leaves the sound untouched.
 */
export function setSoundEffects(settings: SoundSettings): void {
	_sound = settings;
	applySound();
}

/** Whether effects sit in the graph right now (false when all off, or before the context). */
export function isSoundChainActive(): boolean {
	return _chain !== null;
}

function applySound(): void {
	if (!_ctx || !_analyser || !_bus) return;
	let chain: SoundChain | null;
	try {
		chain = buildSoundChain(_ctx, _sound);
	} catch {
		chain = null;
	}
	try {
		_bus.disconnect();
	} catch {}
	if (chain) {
		_bus.connect(chain.input);
		chain.output.connect(_analyser);
	} else {
		_bus.connect(_analyser);
	}
	for (const node of _chain?.nodes ?? []) {
		try {
			node.disconnect();
		} catch {}
	}
	_chain = chain;
}
