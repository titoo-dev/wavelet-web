import { internalMutation } from "./_generated/server";
import { dropActiveDevice, FORGET_AFTER_MS, getSession, OFFLINE_AFTER_MS } from "./lib";

/**
 * Devices that stopped their heartbeat go offline; an Active Device among them is dropped, leaving
 * the session paused at the position it had when last seen. Long-gone Devices are forgotten.
 */
export const sweep = internalMutation({
	args: {},
	handler: async (ctx) => {
		const now = Date.now();
		const stale = await ctx.db
			.query("devices")
			.withIndex("by_online_lastSeen", (q) => q.eq("online", true).lt("lastSeen", now - OFFLINE_AFTER_MS))
			.take(500);
		for (const device of stale) {
			await ctx.db.patch(device._id, { online: false });
			const session = await getSession(ctx, device.userId);
			if (session?.activeDeviceId === device.deviceId) await dropActiveDevice(ctx, session, device.lastSeen);
		}
		const forgotten = await ctx.db
			.query("devices")
			.withIndex("by_online_lastSeen", (q) => q.eq("online", false).lt("lastSeen", now - FORGET_AFTER_MS))
			.take(500);
		await Promise.all(forgotten.map((d) => ctx.db.delete(d._id)));
	},
});
