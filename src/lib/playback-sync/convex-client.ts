import { ConvexClient } from "convex/browser";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import type { SyncClient } from "./types";

/** Trades this tab's session cookie for the short-lived JWT Convex trusts (docs/adr/0002). */
export async function fetchConvexToken(): Promise<string | null> {
	try {
		const res = await fetch("/api/auth/token", { credentials: "include", cache: "no-store" });
		if (!res.ok) return null;
		const body = (await res.json()) as { token?: string };
		return body.token ?? null;
	} catch {
		return null;
	}
}

/** The sync's Convex functions on a real deployment. */
export function createConvexSyncClient(url: string): SyncClient {
	const client = new ConvexClient(url);
	let lastToken: string | null = null;
	client.setAuth(async () => {
		lastToken = await fetchConvexToken();
		return lastToken;
	});

	const leaveOnUnload = (deviceId: string) => {
		// The socket may not get the mutation out while the page goes away: a keepalive request
		// to the HTTP API does (it carries the JWT, which sendBeacon can't).
		if (!lastToken) return;
		void fetch(`${url}/api/mutation`, {
			method: "POST",
			keepalive: true,
			headers: { "Content-Type": "application/json", Authorization: `Bearer ${lastToken}` },
			body: JSON.stringify({ path: "devices:leave", args: { deviceId }, format: "json" }),
		}).catch(() => {});
	};

	return {
		watchSession: (cb) => client.onUpdate(api.playback.session, {}, cb, () => {}),
		watchQueue: (cb) => client.onUpdate(api.playback.queueOf, {}, cb, () => {}),
		watchDevices: (cb) => client.onUpdate(api.devices.list, {}, cb, () => {}),
		watchPending: (deviceId, cb) => client.onUpdate(api.commands.pending, { deviceId }, cb, () => {}),
		watchOutstanding: (deviceId, cb) => client.onUpdate(api.commands.outstanding, { deviceId }, cb, () => {}),
		heartbeat: (args) => client.mutation(api.devices.heartbeat, args),
		leave: (deviceId) => client.mutation(api.devices.leave, { deviceId }),
		publish: (args) => client.mutation(api.playback.publish, args),
		claim: (args) => client.mutation(api.playback.claim, args),
		reclaim: (args) => client.mutation(api.playback.reclaim, args),
		transfer: (targetDeviceId) => client.mutation(api.playback.transfer, { targetDeviceId }),
		send: (fromDeviceId, command) => client.mutation(api.commands.send, { fromDeviceId, command }),
		ack: (deviceId, ids) => client.mutation(api.commands.ack, { deviceId, ids: ids as Id<"commands">[] }),
		leaveOnUnload,
		close: () => void client.close(),
	};
}
