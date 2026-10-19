import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { command, platform, playbackState, queue } from "./validators";

// Convex holds the Playback Session and the Devices only; Postgres stays the source of truth for
// everything else, and users are named by their better-auth id (docs/adr/0001).
export default defineSchema({
	devices: defineTable({
		userId: v.string(),
		/** Chosen by the client: a tab keeps it across reloads, the app across launches. */
		deviceId: v.string(),
		name: v.string(),
		platform,
		/** Allowed to output sound right now (CONTEXT.md, Activated Device). */
		activated: v.boolean(),
		/** 0..1, so a Remote can show and change the Active Device's volume. */
		volume: v.optional(v.number()),
		lastSeen: v.number(),
		online: v.boolean(),
	})
		.index("by_user_device", ["userId", "deviceId"])
		.index("by_online_lastSeen", ["online", "lastSeen"]),

	playbackSessions: defineTable({
		userId: v.string(),
		activeDeviceId: v.union(v.string(), v.null()),
		/** The last Device that was active: the one allowed to reclaim when it comes back. */
		lastActiveDeviceId: v.union(v.string(), v.null()),
		state: playbackState,
		/** Server time `state.positionMs` was true at; Remotes extrapolate from it while playing. */
		positionAt: v.number(),
		/** The Device whose write this is (null for a Transfer): a Device skips the echo of its own writes. */
		updatedBy: v.optional(v.union(v.string(), v.null())),
		/** Bumped on each queue publish, so a Remote knows its queue copy is current. */
		queueVersion: v.number(),
	}).index("by_user", ["userId"]),

	// Kept apart from the session so a play / pause / seek doesn't resend the whole queue to every Remote.
	playbackQueues: defineTable({
		userId: v.string(),
		queue,
		version: v.number(),
	}).index("by_user", ["userId"]),

	commands: defineTable({
		userId: v.string(),
		targetDeviceId: v.string(),
		fromDeviceId: v.string(),
		command,
		createdAt: v.number(),
	})
		.index("by_target", ["userId", "targetDeviceId"])
		.index("by_sender", ["userId", "fromDeviceId"]),
});
