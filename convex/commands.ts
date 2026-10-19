import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { getSession, requireUserId } from "./lib";
import { command } from "./validators";

/**
 * A Remote asks the Active Device to do something (ADR 0003). Refused with no Active Device:
 * the caller then changes the session itself.
 */
export const send = mutation({
	args: { fromDeviceId: v.string(), command },
	handler: async (ctx, { fromDeviceId, command: cmd }) => {
		const userId = await requireUserId(ctx);
		const session = await getSession(ctx, userId);
		const target = session?.activeDeviceId ?? null;
		if (!target) return { ok: false as const, reason: "no-active" as const };
		if (target === fromDeviceId) return { ok: false as const, reason: "is-active" as const };
		const id = await ctx.db.insert("commands", {
			userId,
			targetDeviceId: target,
			fromDeviceId,
			command: cmd,
			createdAt: Date.now(),
		});
		return { ok: true as const, id, targetDeviceId: target };
	},
});

/** Commands waiting for `deviceId`, oldest first: the Active Device carries them out in order. */
export const pending = query({
	args: { deviceId: v.string() },
	handler: async (ctx, { deviceId }) => {
		const userId = await requireUserId(ctx);
		const rows = await ctx.db
			.query("commands")
			.withIndex("by_target", (q) => q.eq("userId", userId).eq("targetDeviceId", deviceId))
			.collect();
		return rows.map(({ _id, command: cmd, fromDeviceId, createdAt }) => ({
			id: _id,
			command: cmd,
			fromDeviceId,
			createdAt,
		}));
	},
});

/** Commands `deviceId` sent that are still unanswered: a Remote says "not responding" after a while. */
export const outstanding = query({
	args: { deviceId: v.string() },
	handler: async (ctx, { deviceId }) => {
		const userId = await requireUserId(ctx);
		const rows = await ctx.db
			.query("commands")
			.withIndex("by_sender", (q) => q.eq("userId", userId).eq("fromDeviceId", deviceId))
			.collect();
		return rows.map(({ _id, targetDeviceId, createdAt }) => ({ id: _id, targetDeviceId, createdAt }));
	},
});

/** The Active Device carried these out; its next publish shows the result. */
export const ack = mutation({
	args: { deviceId: v.string(), ids: v.array(v.id("commands")) },
	handler: async (ctx, { deviceId, ids }) => {
		const userId = await requireUserId(ctx);
		for (const id of ids) {
			const row = await ctx.db.get(id);
			if (row && row.userId === userId && row.targetDeviceId === deviceId) await ctx.db.delete(id);
		}
	},
});
