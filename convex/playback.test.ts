/// <reference types="vite/client" />
// @vitest-environment edge-runtime
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "./_generated/api";
import { EMPTY_STATE, OFFLINE_AFTER_MS } from "./lib";
import schema from "./schema";
import type { PlaybackState, Track } from "./validators";

const modules = import.meta.glob(["./**/*.ts", "./**/*.js", "!./**/*.test.ts", "!./**/*.d.ts"]);

const song = (n: number, duration: number | null = 200): Track => ({
	trackId: String(n),
	title: `Song ${n}`,
	artist: "Artist",
	cover: null,
	duration,
});

const playing = (track: Track, positionMs = 0): PlaybackState => ({
	...EMPTY_STATE,
	index: 0,
	currentTrack: track,
	isPlaying: true,
	positionMs,
});

function setup() {
	const t = convexTest(schema, modules);
	const alice = t.withIdentity({ subject: "alice" });
	const bob = t.withIdentity({ subject: "bob" });
	const online = (as: typeof alice, deviceId: string, activated = true) =>
		as.mutation(api.devices.heartbeat, { deviceId, name: deviceId, platform: "web", activated });
	return { t, alice, bob, online };
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(1_000_000);
});
afterEach(() => vi.useRealTimers());

describe("auth", () => {
	it("refuses every call without a JWT", async () => {
		const { t } = setup();
		await expect(t.query(api.playback.session, {})).rejects.toThrow(/NOT_AUTHENTICATED/);
		await expect(
			t.mutation(api.devices.heartbeat, { deviceId: "a", name: "a", platform: "web", activated: true }),
		).rejects.toThrow(/NOT_AUTHENTICATED/);
	});

	it("keeps users apart", async () => {
		const { alice, bob, online } = setup();
		await online(alice, "tab");
		await alice.mutation(api.playback.claim, { deviceId: "tab", state: playing(song(1)) });
		expect(await bob.query(api.playback.session, {})).toBeNull();
		expect(await bob.query(api.devices.list, {})).toEqual([]);
	});
});

describe("devices", () => {
	it("lists Online Devices with their activation and volume, in a stable order", async () => {
		const { alice, online } = setup();
		await online(alice, "tab", false);
		await alice.mutation(api.devices.heartbeat, {
			deviceId: "phone",
			name: "Pixel",
			platform: "android",
			activated: true,
			volume: 0.5,
		});
		const list = await alice.query(api.devices.list, {});
		expect(list).toEqual([
			{ deviceId: "phone", name: "Pixel", platform: "android", activated: true, volume: 0.5, lastSeen: 1_000_000 },
			{ deviceId: "tab", name: "tab", platform: "web", activated: false, volume: null, lastSeen: 1_000_000 },
		]);
	});

	it("updates a known Device rather than adding it twice", async () => {
		const { alice, online } = setup();
		await online(alice, "tab", false);
		await online(alice, "tab", true);
		expect(await alice.query(api.devices.list, {})).toHaveLength(1);
		expect((await alice.query(api.devices.list, {}))[0].activated).toBe(true);
	});

	it("leave takes a Device off the picker and drops it if it was active", async () => {
		const { alice, online } = setup();
		await online(alice, "tab");
		await alice.mutation(api.playback.claim, { deviceId: "tab", state: playing(song(1), 10_000) });
		vi.advanceTimersByTime(5_000);
		await alice.mutation(api.devices.leave, { deviceId: "tab" });
		expect(await alice.query(api.devices.list, {})).toEqual([]);
		const s = await alice.query(api.playback.session, {});
		expect(s?.activeDeviceId).toBeNull();
		expect(s?.state.isPlaying).toBe(false);
		expect(s?.state.positionMs).toBe(15_000);
	});

	it("leave on an unknown, inactive Device changes nothing", async () => {
		const { alice } = setup();
		await alice.mutation(api.devices.leave, { deviceId: "ghost" });
		expect(await alice.query(api.playback.session, {})).toBeNull();
	});
});

describe("publish / claim", () => {
	it("claim makes the caller the Active Device with its state and queue", async () => {
		const { alice, online } = setup();
		await online(alice, "tab");
		const res = await alice.mutation(api.playback.claim, {
			deviceId: "tab",
			state: playing(song(1)),
			queue: { tracks: [song(1), song(2)], windowStart: 0 },
		});
		expect(res).toEqual({ ok: true, queueVersion: 1 });
		const s = await alice.query(api.playback.session, {});
		expect(s).toMatchObject({ activeDeviceId: "tab", lastActiveDeviceId: "tab", positionAt: 1_000_000, queueVersion: 1 });
		expect(await alice.query(api.playback.queueOf, {})).toEqual({
			tracks: [song(1), song(2)],
			windowStart: 0,
			version: 1,
		});
	});

	it("the second Device to claim is refused and told who is active (was: two Devices playing at once)", async () => {
		const { alice, online } = setup();
		await online(alice, "tab");
		await online(alice, "phone");
		await alice.mutation(api.playback.claim, { deviceId: "tab", state: playing(song(1)) });
		const res = await alice.mutation(api.playback.claim, { deviceId: "phone", state: playing(song(2)) });
		expect(res).toEqual({ ok: false, reason: "not-active", activeDeviceId: "tab" });
		expect((await alice.query(api.playback.session, {}))?.state.currentTrack?.trackId).toBe("1");
	});

	it("only the Active Device may publish", async () => {
		const { alice, online } = setup();
		await online(alice, "tab");
		await alice.mutation(api.playback.claim, { deviceId: "tab", state: playing(song(1)) });
		const refused = await alice.mutation(api.playback.publish, { deviceId: "phone", state: playing(song(9)) });
		expect(refused).toMatchObject({ ok: false, reason: "not-active", activeDeviceId: "tab" });
		const ok = await alice.mutation(api.playback.publish, {
			deviceId: "tab",
			state: { ...playing(song(1), 3_000), isPlaying: false },
		});
		expect(ok).toEqual({ ok: true, queueVersion: 0 });
		expect((await alice.query(api.playback.session, {}))?.state).toMatchObject({ isPlaying: false, positionMs: 3_000 });
	});

	it("with no Active Device any Device writes the session without becoming active", async () => {
		const { alice } = setup();
		const res = await alice.mutation(api.playback.publish, {
			deviceId: "tab",
			state: { ...EMPTY_STATE, shuffle: true },
			queue: { tracks: [song(1)], windowStart: 0 },
		});
		expect(res).toEqual({ ok: true, queueVersion: 1 });
		const s = await alice.query(api.playback.session, {});
		expect(s?.activeDeviceId).toBeNull();
		expect(s?.state.shuffle).toBe(true);
	});

	it("bumps the queue version only when a queue is published", async () => {
		const { alice } = setup();
		await alice.mutation(api.playback.claim, {
			deviceId: "tab",
			state: playing(song(1)),
			queue: { tracks: [song(1)], windowStart: 0 },
		});
		await alice.mutation(api.playback.publish, { deviceId: "tab", state: playing(song(1), 500) });
		expect((await alice.query(api.playback.session, {}))?.queueVersion).toBe(1);
		await alice.mutation(api.playback.publish, {
			deviceId: "tab",
			state: playing(song(1), 500),
			queue: { tracks: [song(1), song(2)], windowStart: 0 },
		});
		expect((await alice.query(api.playback.queueOf, {}))?.version).toBe(2);
	});

	it("rejects a queue window over the limit", async () => {
		const { alice } = setup();
		const tracks = Array.from({ length: 1001 }, (_, i) => song(i));
		await expect(
			alice.mutation(api.playback.claim, { deviceId: "tab", state: playing(tracks[0]), queue: { tracks, windowStart: 0 } }),
		).rejects.toThrow(/over 1000/);
	});

	it("queueOf is null before anything was published", async () => {
		const { alice } = setup();
		expect(await alice.query(api.playback.queueOf, {})).toBeNull();
	});
});

describe("transfer", () => {
	async function playingOnTab() {
		const ctx = setup();
		await ctx.online(ctx.alice, "tab");
		await ctx.online(ctx.alice, "phone");
		await ctx.alice.mutation(api.playback.claim, { deviceId: "tab", state: playing(song(1), 10_000) });
		return ctx;
	}

	it("moves the sound and carries on from the same position", async () => {
		const { alice } = await playingOnTab();
		vi.advanceTimersByTime(4_000);
		expect(await alice.mutation(api.playback.transfer, { targetDeviceId: "phone" })).toMatchObject({ ok: true });
		const s = await alice.query(api.playback.session, {});
		expect(s).toMatchObject({ activeDeviceId: "phone", lastActiveDeviceId: "phone", positionAt: 1_004_000 });
		expect(s?.state).toMatchObject({ isPlaying: true, positionMs: 14_000 });
	});

	it("a paused session stays paused (was: Transfer started playback)", async () => {
		const { alice } = await playingOnTab();
		await alice.mutation(api.playback.publish, { deviceId: "tab", state: { ...playing(song(1), 7_000), isPlaying: false } });
		vi.advanceTimersByTime(60_000 - 1);
		await alice.mutation(api.playback.transfer, { targetDeviceId: "phone" });
		expect((await alice.query(api.playback.session, {}))?.state).toMatchObject({ isPlaying: false, positionMs: 7_000 });
	});

	it("never extrapolates past the end of the track", async () => {
		const { alice } = await playingOnTab();
		vi.advanceTimersByTime(300_000);
		await alice.mutation(api.playback.transfer, { targetDeviceId: "phone" });
		expect((await alice.query(api.playback.session, {}))?.state.positionMs).toBe(200_000);
	});

	it("extrapolates without a cap when the duration is unknown", async () => {
		const { alice, online } = setup();
		await online(alice, "tab");
		await alice.mutation(api.playback.claim, { deviceId: "tab", state: playing(song(1, null), 0) });
		vi.advanceTimersByTime(10_000);
		await online(alice, "phone");
		await alice.mutation(api.playback.transfer, { targetDeviceId: "phone" });
		expect((await alice.query(api.playback.session, {}))?.state.positionMs).toBe(10_000);
	});

	it("drops the Commands the previous Active Device never carried out", async () => {
		const { alice } = await playingOnTab();
		await alice.mutation(api.commands.send, { fromDeviceId: "phone", command: { type: "next" } });
		await alice.mutation(api.playback.transfer, { targetDeviceId: "phone" });
		expect(await alice.query(api.commands.pending, { deviceId: "tab" })).toEqual([]);
	});

	it("refuses an unknown or offline Device", async () => {
		const { alice } = await playingOnTab();
		expect(await alice.mutation(api.playback.transfer, { targetDeviceId: "ghost" })).toMatchObject({
			ok: false,
			reason: "unknown-device",
		});
		await alice.mutation(api.devices.leave, { deviceId: "phone" });
		expect(await alice.query(api.playback.session, {})).toMatchObject({ activeDeviceId: "tab" });
		expect(await alice.mutation(api.playback.transfer, { targetDeviceId: "phone" })).toMatchObject({
			ok: false,
			reason: "offline",
			activeDeviceId: "tab",
		});
	});

	it("moves the sound to a tab that never had a click, which asks for one if its browser won't play (was: refused, the phone could not pick the PC)", async () => {
		const { alice, online } = await playingOnTab();
		await online(alice, "fresh-tab", false);
		expect(await alice.mutation(api.playback.transfer, { targetDeviceId: "fresh-tab" })).toMatchObject({ ok: true });
		expect(await alice.query(api.playback.session, {})).toMatchObject({ activeDeviceId: "fresh-tab" });
	});

	it("is a no-op toward the Device already active", async () => {
		const { alice } = await playingOnTab();
		vi.advanceTimersByTime(3_000);
		expect(await alice.mutation(api.playback.transfer, { targetDeviceId: "tab" })).toEqual({ ok: true, queueVersion: 0 });
		expect((await alice.query(api.playback.session, {}))?.positionAt).toBe(1_000_000);
	});

	it("works with no Active Device (picks where a paused session resumes)", async () => {
		const { alice, online } = setup();
		await online(alice, "phone");
		expect(await alice.mutation(api.playback.transfer, { targetDeviceId: "phone" })).toMatchObject({ ok: true });
		expect((await alice.query(api.playback.session, {}))?.activeDeviceId).toBe("phone");
	});
});

describe("commands", () => {
	async function remoteAndActive() {
		const ctx = setup();
		await ctx.online(ctx.alice, "tab");
		await ctx.online(ctx.alice, "phone");
		await ctx.alice.mutation(api.playback.claim, { deviceId: "phone", state: playing(song(1)) });
		return ctx;
	}

	it("a Remote's Command waits for the Active Device, in order, until acked", async () => {
		const { alice } = await remoteAndActive();
		const a = await alice.mutation(api.commands.send, { fromDeviceId: "tab", command: { type: "pause" } });
		vi.advanceTimersByTime(10);
		const b = await alice.mutation(api.commands.send, {
			fromDeviceId: "tab",
			command: { type: "seek", positionMs: 42_000 },
		});
		expect(a).toMatchObject({ ok: true, targetDeviceId: "phone" });
		const pending = await alice.query(api.commands.pending, { deviceId: "phone" });
		expect(pending.map((c) => c.command)).toEqual([{ type: "pause" }, { type: "seek", positionMs: 42_000 }]);
		expect(await alice.query(api.commands.outstanding, { deviceId: "tab" })).toHaveLength(2);

		await alice.mutation(api.commands.ack, { deviceId: "phone", ids: [a.ok ? a.id : never(), b.ok ? b.id : never()] });
		expect(await alice.query(api.commands.pending, { deviceId: "phone" })).toEqual([]);
		expect(await alice.query(api.commands.outstanding, { deviceId: "tab" })).toEqual([]);
	});

	it("only the target Device can ack a Command", async () => {
		const { alice } = await remoteAndActive();
		const a = await alice.mutation(api.commands.send, { fromDeviceId: "tab", command: { type: "next" } });
		await alice.mutation(api.commands.ack, { deviceId: "tab", ids: [a.ok ? a.id : never()] });
		expect(await alice.query(api.commands.pending, { deviceId: "phone" })).toHaveLength(1);
	});

	it("another user cannot ack them", async () => {
		const { alice, bob } = await remoteAndActive();
		const a = await alice.mutation(api.commands.send, { fromDeviceId: "tab", command: { type: "next" } });
		await bob.mutation(api.commands.ack, { deviceId: "phone", ids: [a.ok ? a.id : never()] });
		expect(await alice.query(api.commands.pending, { deviceId: "phone" })).toHaveLength(1);
	});

	it("is refused with no Active Device, so the caller changes the session itself", async () => {
		const { alice } = setup();
		expect(await alice.mutation(api.commands.send, { fromDeviceId: "tab", command: { type: "next" } })).toEqual({
			ok: false,
			reason: "no-active",
		});
	});

	it("is refused from the Active Device itself", async () => {
		const { alice } = await remoteAndActive();
		expect(await alice.mutation(api.commands.send, { fromDeviceId: "phone", command: { type: "next" } })).toEqual({
			ok: false,
			reason: "is-active",
		});
	});
});

describe("presence sweep", () => {
	it("drops an Active Device that went silent: paused at the position it had when last seen", async () => {
		const { t, alice, online } = setup();
		await online(alice, "phone");
		await online(alice, "tab");
		await alice.mutation(api.playback.claim, { deviceId: "phone", state: playing(song(1), 20_000) });
		await alice.mutation(api.commands.send, { fromDeviceId: "tab", command: { type: "next" } });
		vi.advanceTimersByTime(10_000);
		await online(alice, "phone"); // last sign of life at +10 s
		vi.advanceTimersByTime(OFFLINE_AFTER_MS);
		await online(alice, "tab");
		vi.advanceTimersByTime(1);
		await t.mutation(internal.presence.sweep, {});

		const s = await alice.query(api.playback.session, {});
		expect(s).toMatchObject({ activeDeviceId: null, lastActiveDeviceId: "phone" });
		expect(s?.state).toMatchObject({ isPlaying: false, positionMs: 30_000 });
		expect((await alice.query(api.devices.list, {})).map((d) => d.deviceId)).toEqual(["tab"]);
		expect(await alice.query(api.commands.pending, { deviceId: "phone" })).toEqual([]);
	});

	it("keeps Devices that heartbeat in time", async () => {
		const { t, alice, online } = setup();
		await online(alice, "tab");
		vi.advanceTimersByTime(OFFLINE_AFTER_MS - 1);
		await t.mutation(internal.presence.sweep, {});
		expect(await alice.query(api.devices.list, {})).toHaveLength(1);
	});

	it("forgets Devices gone for a month", async () => {
		const { t, alice, online } = setup();
		await online(alice, "old");
		await alice.mutation(api.devices.leave, { deviceId: "old" });
		vi.advanceTimersByTime(31 * 24 * 60 * 60 * 1000);
		await t.mutation(internal.presence.sweep, {});
		const rows = await t.run((ctx) => ctx.db.query("devices").collect());
		expect(rows).toEqual([]);
	});
});

describe("reclaim", () => {
	async function dropped() {
		const ctx = setup();
		await ctx.online(ctx.alice, "phone");
		await ctx.alice.mutation(api.playback.claim, { deviceId: "phone", state: playing(song(1)) });
		vi.advanceTimersByTime(OFFLINE_AFTER_MS + 1);
		await ctx.t.mutation(internal.presence.sweep, {});
		return ctx;
	}

	it("a dropped Device comes back active when nobody took over, its local state replacing the session", async () => {
		const { alice } = await dropped();
		const res = await alice.mutation(api.playback.reclaim, {
			deviceId: "phone",
			state: playing(song(5), 1_000),
			queue: { tracks: [song(5)], windowStart: 0 },
		});
		expect(res).toMatchObject({ ok: true });
		const s = await alice.query(api.playback.session, {});
		expect(s).toMatchObject({ activeDeviceId: "phone" });
		expect(s?.state.currentTrack?.trackId).toBe("5");
	});

	it("is refused when another Device became active meanwhile: it becomes a Remote", async () => {
		const { alice, online } = await dropped();
		await online(alice, "tab");
		await alice.mutation(api.playback.claim, { deviceId: "tab", state: playing(song(2)) });
		const res = await alice.mutation(api.playback.reclaim, { deviceId: "phone", state: playing(song(5)) });
		expect(res).toEqual({ ok: false, reason: "not-active", activeDeviceId: "tab" });
	});

	it("is refused to a Device that was not the last active one", async () => {
		const { alice } = await dropped();
		const res = await alice.mutation(api.playback.reclaim, { deviceId: "tab", state: playing(song(5)) });
		expect(res).toEqual({ ok: false, reason: "not-active", activeDeviceId: null });
	});

	it("is accepted for the Device still active (it never got dropped)", async () => {
		const { alice, online } = setup();
		await online(alice, "phone");
		await alice.mutation(api.playback.claim, { deviceId: "phone", state: playing(song(1)) });
		expect(await alice.mutation(api.playback.reclaim, { deviceId: "phone", state: playing(song(1)) })).toMatchObject({
			ok: true,
		});
	});
});

function never(): never {
	throw new Error("unexpected rejection");
}

describe("updatedBy", () => {
	it("names the writer, and nobody for a Transfer, so a Device can skip its own echo", async () => {
		const { alice, online } = setup();
		await online(alice, "tab");
		await online(alice, "phone");
		await alice.mutation(api.playback.claim, { deviceId: "tab", state: playing(song(1)) });
		expect((await alice.query(api.playback.session, {}))?.updatedBy).toBe("tab");
		await alice.mutation(api.playback.transfer, { targetDeviceId: "phone" });
		expect((await alice.query(api.playback.session, {}))?.updatedBy).toBeNull();
	});
});
