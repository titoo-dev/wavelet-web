import { describe, it, expect } from "vitest";
import { buildSoundChain } from "./sound-graph";
import { DEFAULT_SOUND, EQ_BANDS, EQ_PRESETS, crossfeedFor, roomFor, type SoundSettings } from "@/components/audio/engine/sound";
import { soundNodeFactories, type GraphNode, type FakeBuffer } from "@/test/helpers/fake-audio-graph";

type Gain = GraphNode & { gain: { value: number } };
type Biquad = GraphNode & { type: string; frequency: { value: number }; gain: { value: number } };

function build(settings: Partial<SoundSettings>) {
	const ctx = soundNodeFactories(48000);
	const chain = buildSoundChain(ctx as unknown as BaseAudioContext, { ...DEFAULT_SOUND, ...settings });
	return { ctx, chain };
}

/** Follows single-output links from `from` until a node with no or several outputs. */
function walk(from: GraphNode): GraphNode[] {
	const path = [from];
	let node = from;
	while (node.outputs.length === 1) {
		node = node.outputs[0].node;
		path.push(node);
	}
	return path;
}

describe("buildSoundChain", () => {
	it("builds nothing when every effect is off (the file plays untouched)", () => {
		const { ctx, chain } = build({});
		expect(chain).toBeNull();
		expect(ctx.made).toHaveLength(0);
	});

	it("spreads a mono source to both channels at the input", () => {
		const { chain } = build({ spatial: "studio" });
		const input = chain!.input as unknown as GraphNode;
		expect(input.channelCount).toBe(2);
		expect(input.channelCountMode).toBe("explicit");
		expect(input.channelInterpretation).toBe("speakers");
	});

	it("equaliser: preamp at the highest boost, a low shelf, eight peaks, a high shelf, then the limiter", () => {
		const { chain } = build({ eqPreset: "bass" });
		const path = walk(chain!.input as unknown as GraphNode);
		const [input, preamp, ...rest] = path;
		expect(input.kind).toBe("gain");
		expect((preamp as Gain).gain.value).toBeCloseTo(10 ** (-6 / 20), 6);
		const bands = rest.slice(0, EQ_BANDS.length) as Biquad[];
		expect(bands.map((b) => b.type)).toEqual(["lowshelf", ...Array(8).fill("peaking"), "highshelf"]);
		expect(bands.map((b) => b.frequency.value)).toEqual([...EQ_BANDS]);
		expect(bands.map((b) => b.gain.value)).toEqual(EQ_PRESETS.bass);
		expect(path.at(-1)).toBe(chain!.output);
		expect(path.at(-1)!.kind).toBe("compressor");
	});

	it("crossfeed: each channel goes straight to its own ear and, low-passed and delayed, to the other", () => {
		const { ctx, chain } = build({ spatial: "studio" });
		const cf = crossfeedFor("studio")!;
		const splitter = ctx.made.find((n) => n.kind === "splitter")!;
		const merger = ctx.made.find((n) => n.kind === "merger")!;
		expect(ctx.made.some((n) => n.kind === "convolver")).toBe(false);
		for (const ch of [0, 1]) {
			const fromCh = splitter.outputs.filter((e) => e.output === ch).map((e) => e.node);
			expect(fromCh).toHaveLength(2);
			const [direct, cross] = fromCh.map(walk);
			expect((direct[0] as Biquad).type).toBe("highshelf");
			expect((direct[1] as Gain).gain.value).toBeCloseTo(cf.makeup, 6);
			expect(direct[1].outputs[0]).toMatchObject({ node: merger, output: 0, input: ch });
			expect((cross[0] as Biquad).type).toBe("lowpass");
			expect(cross[1].kind).toBe("delay");
			expect((cross[2] as Gain).gain.value).toBeCloseTo(cf.feed * cf.makeup, 6);
			expect(cross[2].outputs[0]).toMatchObject({ node: merger, output: 0, input: 1 - ch });
		}
		expect(walk(merger).at(-1)).toBe(chain!.output);
	});

	it("room: the dry signal plus a high-passed stereo convolver at the room's level", () => {
		const { ctx, chain } = build({ spatial: "hall" });
		const room = roomFor("hall")!;
		const convolver = ctx.made.find((n) => n.kind === "convolver") as GraphNode & { buffer: FakeBuffer };
		expect(convolver.buffer.numberOfChannels).toBe(2);
		expect(convolver.buffer.length).toBe(Math.round((room.preDelayS + room.decayS) * 48000));
		expect(convolver.buffer.channels[0].some((v) => v !== 0)).toBe(true);
		const wet = convolver.outputs[0].node as Gain;
		expect(wet.gain.value).toBeCloseTo(room.wet, 6);
		const mix = wet.outputs[0].node;
		const merger = ctx.made.find((n) => n.kind === "merger")!;
		expect(merger.next).toContain(mix);
		const highPass = merger.next.find((n) => n !== mix) as Biquad;
		expect(highPass.type).toBe("highpass");
		expect(highPass.next).toEqual([convolver]);
		expect(mix.next).toEqual([chain!.output]);
	});

	it("chains the equaliser ahead of the spatial stage", () => {
		const { ctx, chain } = build({ spatial: "room", eqPreset: "vocal" });
		const path = walk(chain!.input as unknown as GraphNode);
		expect(path.at(-1)!.kind).toBe("splitter");
		expect(path.filter((n) => n.kind === "biquad")).toHaveLength(EQ_BANDS.length);
		expect(ctx.made.filter((n) => n.kind === "compressor")).toHaveLength(1);
	});

	it("lists every node it made, to disconnect the chain when it is replaced", () => {
		const { ctx, chain } = build({ spatial: "hall", eqPreset: "loudness" });
		expect(chain!.nodes).toEqual(ctx.made);
	});
});
