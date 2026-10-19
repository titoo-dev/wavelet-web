import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/utils/haptic", () => ({ haptic: vi.fn() }));

import { usePlayerStore, type PlayerTrack } from "@/stores/usePlayerStore";
import { isRemote, setRemoteSender } from "./remote";
import { HEARTBEAT_MS, PlaybackSync, POSITION_REFRESH_MS, UNRESPONSIVE_MS } from "./sync";
import { toSessionTrack } from "./track";
import { useSyncStore } from "./useSyncStore";
import type {
	DeviceView,
	OutstandingCommand,
	PendingCommand,
	PlaybackState,
	PublishArgs,
	QueueView,
	SessionView,
	SyncClient,
	WriteResult,
} from "./types";

const INITIAL = usePlayerStore.getState();
const ME = "tab-1";

const t = (id: string, duration = 200): PlayerTrack => ({ trackId: id, title: `T${id}`, artist: "A", cover: null, duration });

function state(over: Partial<PlaybackState> = {}): PlaybackState {
	return { index: -1, currentTrack: null, isPlaying: false, positionMs: 0, shuffle: false, repeat: "off", ...over };
}

function session(over: Partial<SessionView> = {}): SessionView {
	return {
		activeDeviceId: null,
		lastActiveDeviceId: null,
		state: state(),
		positionAt: 0,
		queueVersion: 1,
		updatedBy: "phone",
		...over,
	};
}

const device = (deviceId: string, over: Partial<DeviceView> = {}): DeviceView => ({
	deviceId,
	name: deviceId,
	platform: "web",
	activated: true,
	volume: null,
	lastSeen: 0,
	...over,
});

class FakeClient implements SyncClient {
	sessionCb: (s: SessionView | null) => void = () => {};
	queueCb: (q: QueueView | null) => void = () => {};
	devicesCb: (d: DeviceView[]) => void = () => {};
	pendingCb: (c: PendingCommand[]) => void = () => {};
	outstandingCb: (c: OutstandingCommand[]) => void = () => {};
	writeResult: WriteResult = { ok: true, queueVersion: 1 };
	heartbeat = vi.fn(async () => {});
	leave = vi.fn(async () => {});
	leaveOnUnload = vi.fn();
	publish = vi.fn<(args: PublishArgs) => Promise<WriteResult>>(async () => this.writeResult);
	claim = vi.fn<(args: PublishArgs) => Promise<WriteResult>>(async () => this.writeResult);
	reclaim = vi.fn<(args: PublishArgs) => Promise<WriteResult>>(async () => this.writeResult);
	transfer = vi.fn<(target: string) => Promise<WriteResult>>(async () => this.writeResult);
	send = vi.fn(async (): Promise<Awaited<ReturnType<SyncClient["send"]>>> => ({ ok: true, id: "c1", targetDeviceId: "phone" }));
	ack = vi.fn(async () => {});
	close = vi.fn();
	unsubscribed = 0;
	private sub<T>(set: (cb: T) => void) {
		return (cb: T) => {
			set(cb);
			return () => void this.unsubscribed++;
		};
	}
	watchSession = this.sub<(s: SessionView | null) => void>((cb) => (this.sessionCb = cb));
	watchQueue = this.sub<(q: QueueView | null) => void>((cb) => (this.queueCb = cb));
	watchDevices = this.sub<(d: DeviceView[]) => void>((cb) => (this.devicesCb = cb));
	watchPending = (_: string, cb: (c: PendingCommand[]) => void) => this.sub<typeof cb>((c) => (this.pendingCb = c))(cb);
	watchOutstanding = (_: string, cb: (c: OutstandingCommand[]) => void) =>
		this.sub<typeof cb>((c) => (this.outstandingCb = c))(cb);
}

let client: FakeClient;
let sync: PlaybackSync;
let activated: boolean;
let onUnresponsive: ReturnType<typeof vi.fn<(deviceName: string) => void>>;

function start() {
	sync = new PlaybackSync({
		client,
		deviceId: ME,
		deviceName: "Chrome · Windows",
		isActivated: () => activated,
		onUnresponsive,
	});
	sync.start();
}

/** Lets the sync's debounced publish and awaited mutations run. */
async function flush(ms = 60) {
	await vi.advanceTimersByTimeAsync(ms);
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(1_000_000);
	usePlayerStore.setState(INITIAL, true);
	useSyncStore.getState().reset();
	setRemoteSender(null);
	client = new FakeClient();
	activated = false;
	onUnresponsive = vi.fn<(deviceName: string) => void>();
});

afterEach(() => {
	sync?.stop();
	vi.useRealTimers();
});

describe("presence", () => {
	it("heartbeats at once and every 15 s with its name and activation", async () => {
		start();
		expect(client.heartbeat).toHaveBeenLastCalledWith({
			deviceId: ME,
			name: "Chrome · Windows",
			platform: "web",
			activated: false,
		});
		activated = true;
		await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
		expect(client.heartbeat).toHaveBeenCalledTimes(2);
		expect(client.heartbeat).toHaveBeenLastCalledWith(expect.objectContaining({ activated: true }));
	});

	it("heartbeats right away when the tab gets its first click", () => {
		start();
		activated = true;
		sync.activationChanged();
		expect(client.heartbeat).toHaveBeenCalledTimes(2);
		sync.activationChanged();
		expect(client.heartbeat).toHaveBeenCalledTimes(2);
	});

	it("lists the devices for the picker", () => {
		start();
		client.devicesCb([device("phone"), device(ME)]);
		expect(useSyncStore.getState().devices.map((d) => d.deviceId)).toEqual(["phone", ME]);
	});

	it("stop leaves, closes and gives the player back to itself", () => {
		start();
		client.sessionCb(session({ activeDeviceId: "phone" }));
		expect(isRemote()).toBe(true);
		sync.stop();
		expect(client.leave).toHaveBeenCalledWith(ME);
		expect(client.close).toHaveBeenCalled();
		expect(client.unsubscribed).toBe(5);
		expect(isRemote()).toBe(false);
		expect(useSyncStore.getState().role).toBe("local");
		sync.stop();
		expect(client.leave).toHaveBeenCalledTimes(1);
	});
});

describe("Remote", () => {
	function asRemote(over: Partial<SessionView> = {}) {
		start();
		client.devicesCb([device("phone", { name: "Pixel", volume: 0.4 }), device(ME)]);
		client.queueCb({ tracks: [t("1"), t("2"), t("3")].map(toSessionTrack), windowStart: 0, version: 1 });
		client.sessionCb(
			session({
				activeDeviceId: "phone",
				state: state({ index: 1, currentTrack: toSessionTrack(t("2")), isPlaying: true, positionMs: 30_000 }),
				...over,
			})
		);
	}

	it("mirrors the session into the player: queue, track, position, modes", () => {
		asRemote();
		const p = usePlayerStore.getState();
		expect(useSyncStore.getState()).toMatchObject({ role: "remote", activeDeviceId: "phone" });
		expect(p.queue.map((x) => x.trackId)).toEqual(["1", "2", "3"]);
		expect(p).toMatchObject({ queueIndex: 1, isPlaying: true, currentTime: 30, duration: 200 });
		expect(p.currentTrack?.trackId).toBe("2");
	});

	it("moves the position on while the Active Device plays", async () => {
		asRemote();
		await vi.advanceTimersByTimeAsync(1_000);
		expect(usePlayerStore.getState().currentTime).toBeCloseTo(31);
	});

	it("stops moving it when the session pauses", async () => {
		asRemote();
		client.sessionCb(session({ activeDeviceId: "phone", state: state({ index: 1, currentTrack: toSessionTrack(t("2")), positionMs: 31_000 }) }));
		await vi.advanceTimersByTimeAsync(1_000);
		expect(usePlayerStore.getState().currentTime).toBe(31);
	});

	it("turns player actions into Commands instead of playing (was: the tab played too)", () => {
		asRemote();
		usePlayerStore.getState().next();
		usePlayerStore.getState().play(t("9"), [t("8"), t("9")]);
		expect(client.send).toHaveBeenNthCalledWith(1, ME, { type: "next" });
		expect(client.send).toHaveBeenNthCalledWith(2, ME, {
			type: "playQueue",
			tracks: [t("8"), t("9")].map(toSessionTrack),
			startIndex: 1,
		});
		expect(usePlayerStore.getState().currentTrack?.trackId).toBe("2");
	});

	it("says when the Active Device does not answer, once per Command", async () => {
		asRemote();
		client.outstandingCb([{ id: "c1", targetDeviceId: "phone", createdAt: 0 }]);
		await vi.advanceTimersByTimeAsync(UNRESPONSIVE_MS - 1_000);
		expect(onUnresponsive).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(2_000);
		expect(onUnresponsive).toHaveBeenCalledWith("Pixel");
		await vi.advanceTimersByTimeAsync(5_000);
		expect(onUnresponsive).toHaveBeenCalledTimes(1);
	});

	it("does not complain about Commands that got answered", async () => {
		asRemote();
		client.outstandingCb([{ id: "c1", targetDeviceId: "phone", createdAt: 0 }]);
		await vi.advanceTimersByTimeAsync(1_000);
		client.outstandingCb([]);
		await vi.advanceTimersByTimeAsync(10_000);
		expect(onUnresponsive).not.toHaveBeenCalled();
	});

	it("carries an action out itself when nobody plays anymore", async () => {
		asRemote();
		client.send.mockResolvedValueOnce({ ok: false, reason: "no-active" });
		usePlayerStore.getState().jumpToIndex(2);
		await flush(0);
		expect(useSyncStore.getState().role).toBe("idle");
		expect(usePlayerStore.getState().currentTrack?.trackId).toBe("3");
	});

	it("updates the queue when the Active Device publishes a new one", () => {
		asRemote();
		client.queueCb({ tracks: [t("7")].map(toSessionTrack), windowStart: 0, version: 2 });
		expect(usePlayerStore.getState().queue.map((x) => x.trackId)).toEqual(["7"]);
	});

	it("keeps the player's track object when the track did not change (no reload)", () => {
		asRemote();
		const before = usePlayerStore.getState().currentTrack;
		client.sessionCb(session({ activeDeviceId: "phone", state: state({ index: 1, currentTrack: toSessionTrack(t("2")), positionMs: 50_000 }) }));
		expect(usePlayerStore.getState().currentTrack).toBe(before);
	});
});

describe("Active Device", () => {
	async function asActive() {
		start();
		usePlayerStore.setState({ queue: [t("1"), t("2")], queueIndex: 0, currentTrack: t("1"), isPlaying: true });
		client.sessionCb(session({ activeDeviceId: ME, updatedBy: ME, state: state({ index: 0, currentTrack: toSessionTrack(t("1")), isPlaying: true }) }));
		await flush();
		client.publish.mockClear();
	}

	it("a Transfer here takes the session over as it stands", () => {
		start();
		client.queueCb({ tracks: [t("1"), t("2")].map(toSessionTrack), windowStart: 0, version: 3 });
		client.sessionCb(
			session({
				activeDeviceId: ME,
				updatedBy: null,
				state: state({ index: 1, currentTrack: toSessionTrack(t("2")), isPlaying: true, positionMs: 12_000 }),
			})
		);
		expect(useSyncStore.getState().role).toBe("active");
		expect(usePlayerStore.getState()).toMatchObject({ queueIndex: 1, isPlaying: true, currentTime: 12 });
		expect(client.heartbeat).toHaveBeenLastCalledWith(expect.objectContaining({ volume: 0.8 }));
	});

	it("publishes what it plays, the queue only when it changed", async () => {
		await asActive();
		usePlayerStore.getState().pause();
		await flush();
		expect(client.publish).toHaveBeenCalledTimes(1);
		expect(client.publish).toHaveBeenLastCalledWith({
			deviceId: ME,
			state: state({ index: 0, currentTrack: toSessionTrack(t("1")), isPlaying: false }),
		});
		usePlayerStore.getState().addToQueue(t("3"));
		await flush();
		expect(client.publish).toHaveBeenLastCalledWith(
			expect.objectContaining({ queue: { tracks: [t("1"), t("2"), t("3")].map(toSessionTrack), windowStart: 0 } })
		);
	});

	it("groups changes made together into one publish", async () => {
		await asActive();
		usePlayerStore.getState().toggleShuffle();
		usePlayerStore.getState().toggleRepeat();
		usePlayerStore.getState().seek(20);
		await flush();
		expect(client.publish).toHaveBeenCalledTimes(1);
		expect(client.publish.mock.calls[0][0].state).toMatchObject({ shuffle: true, repeat: "all", positionMs: 20_000 });
	});

	it("ignores the engine's own bookkeeping (time updates, buffering)", async () => {
		await asActive();
		usePlayerStore.getState().setCurrentTime(5);
		usePlayerStore.getState().setBuffering(true);
		await flush();
		expect(client.publish).not.toHaveBeenCalled();
	});

	it("corrects the Remotes' position every 15 s while playing", async () => {
		await asActive();
		await vi.advanceTimersByTimeAsync(POSITION_REFRESH_MS + 60);
		expect(client.publish).toHaveBeenCalledTimes(1);
		usePlayerStore.setState({ isPlaying: false });
		await flush();
		client.publish.mockClear();
		await vi.advanceTimersByTimeAsync(POSITION_REFRESH_MS + 60);
		expect(client.publish).not.toHaveBeenCalled();
	});

	it("carries out Commands once each, in order, and acks them", async () => {
		await asActive();
		const pending: PendingCommand[] = [
			{ id: "a", command: { type: "next" }, fromDeviceId: "phone", createdAt: 1 },
			{ id: "b", command: { type: "seek", positionMs: 9_000 }, fromDeviceId: "phone", createdAt: 2 },
		];
		client.pendingCb(pending);
		client.pendingCb(pending); // delivered again before the ack landed
		expect(usePlayerStore.getState().currentTrack?.trackId).toBe("2");
		expect(usePlayerStore.getState().currentTime).toBe(9);
		expect(client.ack).toHaveBeenLastCalledWith(ME, ["a", "b"]);
		expect(usePlayerStore.getState().queueIndex).toBe(1);
	});

	it("runs Commands that arrived before it knew it was active", () => {
		start();
		usePlayerStore.setState({ queue: [t("1"), t("2")], queueIndex: 0, currentTrack: t("1"), isPlaying: true });
		client.pendingCb([{ id: "a", command: { type: "pause" }, fromDeviceId: "phone", createdAt: 1 }]);
		expect(usePlayerStore.getState().isPlaying).toBe(true);
		client.sessionCb(session({ activeDeviceId: ME, updatedBy: ME }));
		expect(usePlayerStore.getState().isPlaying).toBe(false);
	});

	it("tells Remotes its volume soon after it changes", async () => {
		await asActive();
		client.heartbeat.mockClear();
		usePlayerStore.getState().setVolume(30);
		usePlayerStore.getState().setVolume(35);
		await vi.advanceTimersByTimeAsync(300);
		expect(client.heartbeat).toHaveBeenCalledTimes(1);
		expect(client.heartbeat).toHaveBeenLastCalledWith(expect.objectContaining({ volume: 0.35 }));
	});

	it("dropped while still playing: takes the session back when nobody took over", async () => {
		await asActive();
		client.sessionCb(session({ activeDeviceId: null, lastActiveDeviceId: ME }));
		await flush(0);
		expect(client.reclaim).toHaveBeenCalledWith(expect.objectContaining({ deviceId: ME }));
		expect(useSyncStore.getState().role).toBe("active");
	});

	it("dropped and replaced: falls silent and becomes a Remote", async () => {
		await asActive();
		client.writeResult = { ok: false, reason: "not-active", activeDeviceId: "phone" };
		client.sessionCb(session({ activeDeviceId: null, lastActiveDeviceId: ME }));
		await flush(0);
		expect(useSyncStore.getState().role).toBe("remote");
	});

	it("another Device took over: becomes a Remote", async () => {
		await asActive();
		client.sessionCb(session({ activeDeviceId: "phone" }));
		expect(useSyncStore.getState().role).toBe("remote");
		expect(client.heartbeat).toHaveBeenLastCalledWith(expect.not.objectContaining({ volume: expect.anything() }));
	});

	it("keeps playing when a publish fails (offline) and resends the queue next time", async () => {
		await asActive();
		client.publish.mockRejectedValueOnce(new Error("offline"));
		usePlayerStore.getState().addToQueue(t("3"));
		await flush();
		usePlayerStore.getState().pause();
		await flush();
		expect(client.publish).toHaveBeenLastCalledWith(expect.objectContaining({ queue: expect.anything() }));
	});
});

describe("no Active Device", () => {
	it("a first session is seeded from this Device's player", async () => {
		usePlayerStore.setState({ queue: [t("1")], queueIndex: 0, currentTrack: t("1") });
		start();
		client.sessionCb(null);
		await flush();
		expect(useSyncStore.getState().role).toBe("idle");
		expect(client.publish).toHaveBeenCalledWith(expect.objectContaining({ queue: expect.anything() }));
	});

	it("Play makes this Device active", async () => {
		start();
		client.sessionCb(session());
		usePlayerStore.getState().play(t("5"));
		await flush(0);
		expect(client.claim).toHaveBeenCalledWith(
			expect.objectContaining({ deviceId: ME, state: expect.objectContaining({ isPlaying: true }) })
		);
		expect(useSyncStore.getState().role).toBe("active");
	});

	it("Play when another Device got there first: plays there instead", async () => {
		start();
		client.sessionCb(session());
		client.writeResult = { ok: false, reason: "not-active", activeDeviceId: "phone" };
		usePlayerStore.getState().play(t("5"));
		await flush(0);
		expect(useSyncStore.getState().role).toBe("remote");
		expect(client.send).toHaveBeenCalledWith(ME, { type: "playQueue", tracks: [toSessionTrack(t("5"))], startIndex: 0 });
	});

	it("a tab that was already playing claims as soon as it connects", async () => {
		usePlayerStore.setState({ queue: [t("1")], queueIndex: 0, currentTrack: t("1"), isPlaying: true });
		start();
		client.sessionCb(session());
		await flush(0);
		expect(client.claim).toHaveBeenCalled();
	});

	it("queue edits are written to the session directly", async () => {
		start();
		client.sessionCb(session());
		usePlayerStore.setState({ queue: [t("1"), t("2")], queueIndex: 0, currentTrack: t("1") });
		await flush();
		expect(client.publish).toHaveBeenCalledWith(expect.objectContaining({ queue: expect.anything() }));
		expect(client.claim).not.toHaveBeenCalled();
	});

	it("shows the paused session and has the engine start where it is", () => {
		start();
		client.queueCb({ tracks: [t("4")].map(toSessionTrack), windowStart: 0, version: 1 });
		client.sessionCb(session({ state: state({ index: 0, currentTrack: toSessionTrack(t("4")), positionMs: 61_000 }) }));
		expect(usePlayerStore.getState()).toMatchObject({ isPlaying: false, currentTime: 61, _seekTo: 61 });
	});

	it("does not mirror the echo of its own write", () => {
		start();
		usePlayerStore.setState({ queue: [t("1")], queueIndex: 0, currentTrack: t("1") });
		client.queueCb({ tracks: [t("9")].map(toSessionTrack), windowStart: 0, version: 1 });
		client.sessionCb(session({ updatedBy: ME, state: state({ index: 0, currentTrack: toSessionTrack(t("9")) }) }));
		expect(usePlayerStore.getState().currentTrack?.trackId).toBe("1");
	});
});

describe("transfer", () => {
	it("transferring here heartbeats first, so the tab counts as activated", async () => {
		start();
		activated = true;
		client.heartbeat.mockClear();
		await sync.transfer(ME);
		expect(client.heartbeat).toHaveBeenCalledWith(expect.objectContaining({ activated: true }));
		expect(client.transfer).toHaveBeenCalledWith(ME);
		// Sent in that order; the Transfer does not wait for the heartbeat's answer.
		expect(client.heartbeat.mock.invocationCallOrder[0]).toBeLessThan(client.transfer.mock.invocationCallOrder[0]);
	});

	it("transferring elsewhere just asks", async () => {
		start();
		client.heartbeat.mockClear();
		await sync.transfer("phone");
		expect(client.heartbeat).not.toHaveBeenCalled();
		expect(client.transfer).toHaveBeenCalledWith("phone");
	});
});
