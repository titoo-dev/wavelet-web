import { v, type Infer } from "convex/values";

const nullable = <T extends Parameters<typeof v.optional>[0]>(x: T) => v.optional(v.union(x, v.null()));

/** Display metadata of a Deezer track, enough for every Device to show and resolve it (ADR 0001). */
export const track = v.object({
	trackId: v.string(),
	title: v.string(),
	artist: v.string(),
	artistId: nullable(v.string()),
	album: nullable(v.string()),
	albumId: nullable(v.string()),
	cover: nullable(v.string()),
	/** Seconds. */
	duration: nullable(v.number()),
});
export type Track = Infer<typeof track>;

export const platform = v.union(v.literal("web"), v.literal("android"), v.literal("ios"));
export const repeat = v.union(v.literal("off"), v.literal("all"), v.literal("one"));

/** Everything of the Playback Session but the queue, as the Active Device last published it. */
export const playbackState = v.object({
	/** Index of `currentTrack` in the published queue window, -1 when nothing is loaded. */
	index: v.number(),
	currentTrack: v.union(track, v.null()),
	isPlaying: v.boolean(),
	positionMs: v.number(),
	shuffle: v.boolean(),
	repeat,
});
export type PlaybackState = Infer<typeof playbackState>;

/**
 * The queue as published: a window of at most `MAX_QUEUE` tracks. `windowStart` is the index of
 * `tracks[0]` in the Active Device's full queue, so a Command naming a window index can be mapped back.
 */
export const queue = v.object({
	tracks: v.array(track),
	windowStart: v.number(),
});
export type Queue = Infer<typeof queue>;
export const MAX_QUEUE = 1000;

/**
 * What a Remote asks the Active Device to do (CONTEXT.md, Command). Indexes are window indexes of
 * the published queue. The shared vocabulary of the web and Dart clients.
 */
export const command = v.union(
	v.object({ type: v.literal("playQueue"), tracks: v.array(track), startIndex: v.number() }),
	v.object({ type: v.literal("pause") }),
	v.object({ type: v.literal("resume") }),
	v.object({ type: v.literal("next") }),
	v.object({ type: v.literal("prev") }),
	v.object({ type: v.literal("seek"), positionMs: v.number() }),
	v.object({ type: v.literal("jumpTo"), index: v.number() }),
	v.object({ type: v.literal("addNext"), track }),
	v.object({ type: v.literal("addToQueue"), tracks: v.array(track) }),
	v.object({ type: v.literal("remove"), index: v.number() }),
	v.object({ type: v.literal("move"), from: v.number(), to: v.number() }),
	v.object({ type: v.literal("clearUpcoming") }),
	v.object({ type: v.literal("setShuffle"), on: v.boolean() }),
	v.object({ type: v.literal("setRepeat"), mode: repeat }),
	/** 0..1 */
	v.object({ type: v.literal("setVolume"), volume: v.number() }),
);
export type Command = Infer<typeof command>;
