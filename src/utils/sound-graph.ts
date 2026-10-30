/**
 * The Web Audio nodes of the player's sound effects (settings and maths in
 * components/audio/engine/sound.ts), between the element mix and the output:
 *
 *   in (stereo) → preamp → 10 biquads            (equaliser, when not flat)
 *     → splitter ⇉ direct + low-passed, delayed opposite ear ⇉ merger   (crossfeed)
 *     → dry + high-passed convolver with a synthetic room            (room / hall)
 *     → limiter just under full scale
 *
 * Returns null when every effect is off: the caller wires the mix straight
 * to the output and nothing touches the samples.
 */

import {
	EQ_BANDS,
	crossfeedFor,
	dbToGain,
	eqGains,
	eqPreampDb,
	isEqActive,
	isSoundActive,
	roomFor,
	roomImpulse,
	type SoundSettings,
} from "@/components/audio/engine/sound";

export interface SoundChain {
	input: AudioNode;
	output: AudioNode;
	/** Every node of the chain, to disconnect it when it is replaced. */
	nodes: AudioNode[];
}

export function buildSoundChain(ctx: BaseAudioContext, s: SoundSettings): SoundChain | null {
	if (!isSoundActive(s)) return null;
	const nodes: AudioNode[] = [];
	const add = <T extends AudioNode>(node: T): T => {
		nodes.push(node);
		return node;
	};
	const biquad = (type: BiquadFilterType, frequency: number, gainDb = 0, q = Math.SQRT2) => {
		const f = add(ctx.createBiquadFilter());
		f.type = type;
		f.frequency.value = frequency;
		f.gain.value = gainDb;
		f.Q.value = q;
		return f;
	};
	const gain = (value: number) => {
		const g = add(ctx.createGain());
		g.gain.value = value;
		return g;
	};

	// Two channels from here on: a mono file is spread to both ears instead of
	// reaching the splitter as left only.
	const input = gain(1);
	input.channelCount = 2;
	input.channelCountMode = "explicit";
	input.channelInterpretation = "speakers";
	let tail: AudioNode = input;
	const then = (node: AudioNode) => {
		tail.connect(node);
		tail = node;
	};

	if (isEqActive(s)) {
		const gains = eqGains(s);
		then(gain(dbToGain(eqPreampDb(gains))));
		EQ_BANDS.forEach((hz, i) => then(biquad(i === 0 ? "lowshelf" : i === EQ_BANDS.length - 1 ? "highshelf" : "peaking", hz, gains[i])));
	}

	const cf = crossfeedFor(s.spatial);
	if (cf) {
		const split = add(ctx.createChannelSplitter(2));
		const merge = add(ctx.createChannelMerger(2));
		tail.connect(split);
		for (const ch of [0, 1]) {
			const direct = biquad("highshelf", cf.cutoffHz, cf.shelfDb);
			const directGain = gain(cf.makeup);
			split.connect(direct, ch);
			direct.connect(directGain);
			directGain.connect(merge, 0, ch);

			const low = biquad("lowpass", cf.cutoffHz, 0, Math.SQRT1_2);
			const delay = add(ctx.createDelay(0.01));
			delay.delayTime.value = cf.delayS;
			const feed = gain(cf.feed * cf.makeup);
			split.connect(low, ch);
			low.connect(delay);
			delay.connect(feed);
			feed.connect(merge, 0, 1 - ch);
		}
		tail = merge;
	}

	const room = roomFor(s.spatial);
	if (room) {
		const [left, right] = roomImpulse(room, ctx.sampleRate);
		const buffer = ctx.createBuffer(2, left.length, ctx.sampleRate);
		buffer.copyToChannel(left, 0);
		buffer.copyToChannel(right, 1);
		const convolver = add(ctx.createConvolver());
		convolver.buffer = buffer;
		// The bass stays out of the room: a reverberant low end only muddies.
		const highPass = biquad("highpass", 180, 0, Math.SQRT1_2);
		const wet = gain(room.wet);
		const mix = gain(1);
		tail.connect(mix);
		tail.connect(highPass);
		highPass.connect(convolver);
		convolver.connect(wet);
		wet.connect(mix);
		tail = mix;
	}

	// Boosts and the room add level: a fast limiter keeps the peaks clean.
	const limiter = add(ctx.createDynamicsCompressor());
	limiter.threshold.value = -1;
	limiter.knee.value = 0;
	limiter.ratio.value = 20;
	limiter.attack.value = 0.002;
	limiter.release.value = 0.12;
	then(limiter);

	return { input, output: limiter, nodes };
}
