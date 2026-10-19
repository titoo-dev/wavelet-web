import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { dropActiveDevice, getDevice, getSession, requireUserId } from "./lib";
import { platform } from "./validators";

/** A Device says it is alive (every HEARTBEAT_MS, and right away when one of these fields changes). */
export const heartbeat = mutation({
	args: {
		deviceId: v.string(),
		name: v.string(),
		platform,
		activated: v.boolean(),
		volume: v.optional(v.number()),
	},
	handler: async (ctx, args) => {
		const userId = await requireUserId(ctx);
		const now = Date.now();
		const fields = { ...args, lastSeen: now, online: true };
		const existing = await getDevice(ctx, userId, args.deviceId);
		if (existing) await ctx.db.patch(existing._id, fields);
		else await ctx.db.insert("devices", { userId, ...fields });
	},
});

/** The tab closes or the user signs out: off the picker now rather than after OFFLINE_AFTER_MS. */
export const leave = mutation({
	args: { deviceId: v.string() },
	handler: async (ctx, { deviceId }) => {
		const userId = await requireUserId(ctx);
		const device = await getDevice(ctx, userId, deviceId);
		if (device) await ctx.db.patch(device._id, { online: false });
		const session = await getSession(ctx, userId);
		if (session?.activeDeviceId === deviceId) await dropActiveDevice(ctx, session, Date.now());
	},
});

/** The user's Online Devices, for the device picker. */
export const list = query({
	args: {},
	handler: async (ctx) => {
		const userId = await requireUserId(ctx);
		const devices = await ctx.db
			.query("devices")
			.withIndex("by_user_device", (q) => q.eq("userId", userId))
			.collect();
		return devices
			.filter((d) => d.online)
			.map(({ deviceId, name, platform, activated, volume, lastSeen }) => ({
				deviceId,
				name,
				platform,
				activated,
				volume: volume ?? null,
				lastSeen,
			}));
	},
});
