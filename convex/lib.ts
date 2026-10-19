import { ConvexError } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { PlaybackState } from "./validators";

/** How often a Device says it is alive. */
export const HEARTBEAT_MS = 15_000;
/** A Device silent for longer is no longer an Online Device (three missed heartbeats). */
export const OFFLINE_AFTER_MS = 45_000;
/** Devices gone for longer are forgotten. */
export const FORGET_AFTER_MS = 30 * 24 * 60 * 60 * 1000;

export const EMPTY_STATE: PlaybackState = {
	index: -1,
	currentTrack: null,
	isPlaying: false,
	positionMs: 0,
	shuffle: false,
	repeat: "off",
};

/** The better-auth user id of the caller (JWT `sub`), or a NOT_AUTHENTICATED error. */
export async function requireUserId(ctx: QueryCtx | MutationCtx): Promise<string> {
	const identity = await ctx.auth.getUserIdentity();
	if (!identity) throw new ConvexError({ code: "NOT_AUTHENTICATED" });
	return identity.subject;
}

export async function getSession(ctx: QueryCtx | MutationCtx, userId: string) {
	return ctx.db
		.query("playbackSessions")
		.withIndex("by_user", (q) => q.eq("userId", userId))
		.unique();
}

/** The user's session, created empty with no Active Device the first time. */
export async function ensureSession(ctx: MutationCtx, userId: string): Promise<Doc<"playbackSessions">> {
	const existing = await getSession(ctx, userId);
	if (existing) return existing;
	const id = await ctx.db.insert("playbackSessions", {
		userId,
		activeDeviceId: null,
		lastActiveDeviceId: null,
		state: EMPTY_STATE,
		positionAt: Date.now(),
		queueVersion: 0,
	});
	return (await ctx.db.get(id))!;
}

export async function getDevice(ctx: QueryCtx | MutationCtx, userId: string, deviceId: string) {
	return ctx.db
		.query("devices")
		.withIndex("by_user_device", (q) => q.eq("userId", userId).eq("deviceId", deviceId))
		.unique();
}

/** Where the published position is at `now`: it moves on while playing, capped at the track's end. */
export function positionAt(session: Pick<Doc<"playbackSessions">, "state" | "positionAt">, now: number): number {
	const { state } = session;
	if (!state.isPlaying) return state.positionMs;
	const moved = state.positionMs + Math.max(0, now - session.positionAt);
	const durationMs = state.currentTrack?.duration ? state.currentTrack.duration * 1000 : null;
	return durationMs ? Math.min(moved, durationMs) : moved;
}

export async function deleteCommandsFor(ctx: MutationCtx, userId: string, targetDeviceId: string) {
	const pending = await ctx.db
		.query("commands")
		.withIndex("by_target", (q) => q.eq("userId", userId).eq("targetDeviceId", targetDeviceId))
		.collect();
	await Promise.all(pending.map((c) => ctx.db.delete(c._id)));
}

/**
 * The Active Device is gone: the Playback Session is left paused at its last known position with
 * no Active Device (CONTEXT.md, Online Device). Commands it never answered are dropped.
 * `at` is the last moment the Device was known to play.
 */
export async function dropActiveDevice(ctx: MutationCtx, session: Doc<"playbackSessions">, at: number) {
	const deviceId = session.activeDeviceId;
	if (!deviceId) return;
	await ctx.db.patch(session._id, {
		activeDeviceId: null,
		state: { ...session.state, isPlaying: false, positionMs: positionAt(session, at) },
		positionAt: Date.now(),
		updatedBy: null,
	});
	await deleteCommandsFor(ctx, session.userId, deviceId);
}
