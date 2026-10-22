import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { mutation, query, type MutationCtx } from "./_generated/server";
import { deleteCommandsFor, ensureSession, getDevice, getSession, positionAt, requireUserId } from "./lib";
import { MAX_QUEUE, playbackState, queue, type PlaybackState, type Queue } from "./validators";

/** The Playback Session without its queue, which `queueOf` serves on its own. */
export const session = query({
	args: {},
	handler: async (ctx) => {
		const userId = await requireUserId(ctx);
		const s = await getSession(ctx, userId);
		if (!s) return null;
		const { activeDeviceId, lastActiveDeviceId, state, positionAt, queueVersion, updatedBy } = s;
		return { activeDeviceId, lastActiveDeviceId, state, positionAt, queueVersion, updatedBy: updatedBy ?? null };
	},
});

/** The published queue window. */
export const queueOf = query({
	args: {},
	handler: async (ctx) => {
		const userId = await requireUserId(ctx);
		const q = await ctx.db
			.query("playbackQueues")
			.withIndex("by_user", (x) => x.eq("userId", userId))
			.unique();
		return q ? { ...q.queue, version: q.version } : null;
	},
});

type Rejection = {
	ok: false;
	reason: "not-active" | "offline" | "unknown-device";
	activeDeviceId: string | null;
};
type Accepted = { ok: true; queueVersion: number };

async function write(
	ctx: MutationCtx,
	session: Doc<"playbackSessions">,
	by: string | null,
	patch: Partial<Doc<"playbackSessions">>,
	state: PlaybackState,
	nextQueue: Queue | undefined,
): Promise<Accepted> {
	let queueVersion = session.queueVersion;
	if (nextQueue) {
		if (nextQueue.tracks.length > MAX_QUEUE) throw new Error(`queue window over ${MAX_QUEUE} tracks`);
		queueVersion += 1;
		const existing = await ctx.db
			.query("playbackQueues")
			.withIndex("by_user", (x) => x.eq("userId", session.userId))
			.unique();
		if (existing) await ctx.db.patch(existing._id, { queue: nextQueue, version: queueVersion });
		else await ctx.db.insert("playbackQueues", { userId: session.userId, queue: nextQueue, version: queueVersion });
	}
	await ctx.db.patch(session._id, { ...patch, state, positionAt: Date.now(), queueVersion, updatedBy: by });
	return { ok: true, queueVersion };
}

function notActive(session: Doc<"playbackSessions">): Rejection {
	return { ok: false, reason: "not-active", activeDeviceId: session.activeDeviceId };
}

const publishArgs = { deviceId: v.string(), state: playbackState, queue: v.optional(queue) };

/**
 * The Active Device publishes what actually comes out of its speakers (ADR 0003); with no Active
 * Device any Device may write the session directly. `queue` only when it changed.
 */
export const publish = mutation({
	args: publishArgs,
	handler: async (ctx, { deviceId, state, queue: nextQueue }): Promise<Accepted | Rejection> => {
		const userId = await requireUserId(ctx);
		const session = await ensureSession(ctx, userId);
		if (session.activeDeviceId !== null && session.activeDeviceId !== deviceId) return notActive(session);
		return write(ctx, session, deviceId, {}, state, nextQueue);
	},
});

/**
 * Play pressed while there is no Active Device: the caller becomes it, with its state. Refused
 * when another Device got there first; the caller then sends its Play as a Command instead.
 */
export const claim = mutation({
	args: publishArgs,
	handler: async (ctx, { deviceId, state, queue: nextQueue }): Promise<Accepted | Rejection> => {
		const userId = await requireUserId(ctx);
		const session = await ensureSession(ctx, userId);
		if (session.activeDeviceId !== null && session.activeDeviceId !== deviceId) return notActive(session);
		return write(ctx, session, deviceId, { activeDeviceId: deviceId, lastActiveDeviceId: deviceId }, state, nextQueue);
	},
});

/**
 * A dropped Device is back. If nobody became active meanwhile it is active again and its local
 * state replaces the session; otherwise it is refused and becomes a Remote (CONTEXT.md, Online Device).
 */
export const reclaim = mutation({
	args: publishArgs,
	handler: async (ctx, { deviceId, state, queue: nextQueue }): Promise<Accepted | Rejection> => {
		const userId = await requireUserId(ctx);
		const session = await ensureSession(ctx, userId);
		const mine =
			session.activeDeviceId === deviceId ||
			(session.activeDeviceId === null && session.lastActiveDeviceId === deviceId);
		if (!mine) return notActive(session);
		return write(ctx, session, deviceId, { activeDeviceId: deviceId, lastActiveDeviceId: deviceId }, state, nextQueue);
	},
});

/**
 * Move the sound to `targetDeviceId` (CONTEXT.md, Transfer). The intent is kept: a paused session
 * stays paused, a playing one carries on from the same position. Commands the previous Active
 * Device had not carried out are dropped. A tab that never had a click is accepted: if its browser
 * refuses to play, it pauses and asks for that click (CONTEXT.md, Activated Device).
 */
export const transfer = mutation({
	args: { targetDeviceId: v.string() },
	handler: async (ctx, { targetDeviceId }): Promise<Accepted | Rejection> => {
		const userId = await requireUserId(ctx);
		const session = await ensureSession(ctx, userId);
		const target = await getDevice(ctx, userId, targetDeviceId);
		const refuse = (reason: Rejection["reason"]): Rejection => ({
			ok: false,
			reason,
			activeDeviceId: session.activeDeviceId,
		});
		if (!target) return refuse("unknown-device");
		if (!target.online) return refuse("offline");
		if (session.activeDeviceId === targetDeviceId) return { ok: true, queueVersion: session.queueVersion };
		const previous = session.activeDeviceId;
		const state = { ...session.state, positionMs: positionAt(session, Date.now()) };
		const result = await write(
			ctx,
			session,
			null,
			{ activeDeviceId: targetDeviceId, lastActiveDeviceId: targetDeviceId },
			state,
			undefined,
		);
		if (previous) await deleteCommandsFor(ctx, userId, previous);
		return result;
	},
});
