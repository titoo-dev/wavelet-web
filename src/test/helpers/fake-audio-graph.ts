/**
 * Recording stand-ins for the Web Audio nodes of the sound effects
 * (utils/sound-graph.ts): every node remembers what it feeds, on which output
 * and input, so a test can walk the graph.
 */

export interface Edge {
	node: GraphNode;
	output: number;
	input: number;
}

export class GraphNode {
	outputs: Edge[] = [];
	disconnected = false;
	channelCount = 2;
	channelCountMode = "max";
	channelInterpretation = "speakers";
	constructor(readonly kind: string) {}
	connect(node: GraphNode, output = 0, input = 0) {
		this.outputs.push({ node, output, input });
		return node;
	}
	disconnect() {
		this.disconnected = true;
		this.outputs = [];
	}
	/** The nodes this one feeds, in connection order. */
	get next(): GraphNode[] {
		return this.outputs.map((e) => e.node);
	}
}

const param = (value = 0) => ({ value });

export class FakeBuffer {
	channels: Float32Array[];
	constructor(
		readonly numberOfChannels: number,
		readonly length: number,
		readonly sampleRate: number
	) {
		this.channels = Array.from({ length: numberOfChannels }, () => new Float32Array(length));
	}
	copyToChannel(data: Float32Array, ch: number) {
		this.channels[ch].set(data);
	}
}

/** The node factories of a BaseAudioContext (createGain included); `made` lists every node, in order. */
export function soundNodeFactories(sampleRate = 48000) {
	const made: GraphNode[] = [];
	const make = <T extends GraphNode>(node: T): T => {
		made.push(node);
		return node;
	};
	return {
		made,
		sampleRate,
		createGain: () => make(Object.assign(new GraphNode("gain"), { gain: param(1) })),
		createBiquadFilter: () => make(Object.assign(new GraphNode("biquad"), { type: "lowpass", frequency: param(350), gain: param(), Q: param(1) })),
		createChannelSplitter: (n: number) => make(Object.assign(new GraphNode("splitter"), { outputsCount: n })),
		createChannelMerger: (n: number) => make(Object.assign(new GraphNode("merger"), { inputsCount: n })),
		createDelay: (max: number) => make(Object.assign(new GraphNode("delay"), { max, delayTime: param() })),
		createConvolver: () => make(Object.assign(new GraphNode("convolver"), { buffer: null as FakeBuffer | null, normalize: true })),
		createDynamicsCompressor: () =>
			make(Object.assign(new GraphNode("compressor"), { threshold: param(-24), knee: param(30), ratio: param(12), attack: param(0.003), release: param(0.25) })),
		createBuffer: (channels: number, length: number, rate: number) => new FakeBuffer(channels, length, rate),
	};
}

export type SoundNodeFactories = ReturnType<typeof soundNodeFactories>;
