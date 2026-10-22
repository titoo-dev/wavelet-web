import { usePlayerStore } from "@/stores/usePlayerStore";
import { executeCommand } from "./execute";
import { setRemoteSender, setRemoteVolume } from "./remote";
import { extrapolate, ServerClock, toPlayerTrack, toSession } from "./track";
import { useSyncStore } from "./useSyncStore";
import type {
	Command,
	DeviceView,
	OutstandingCommand,
	PendingCommand,
	PlaybackRole,
	QueueView,
	SessionView,
	SyncClient,
	WriteResult,
} from "./types";

/** How often a Device says it is alive (convex/lib.ts HEARTBEAT_MS). */
export const HEARTBEAT_MS = 15_000;
/** The Active Device corrects the position Remotes extrapolate this often while playing. */
export const POSITION_REFRESH_MS = 15_000;
/** A Command unanswered for this long means the Active Device is not responding. */
export const UNRESPONSIVE_MS = 5_000;
/** Remotes move their position this often while the Active Device plays. */
const TICK_MS = 250;
/** Store changes within this window go out as one publish. */
const PUBLISH_DEBOUNCE_MS = 50;
/** A Remote's volume Commands go out at most this often while a slider is dragged. */
export const VOLUME_THROTTLE_MS = 150;
/** A Remote shows the volume it set for this long, then the Active Device's own report. */
export const VOLUME_HOLD_MS = 1_500;

export interface SyncOptions {
	client: SyncClient;
	deviceId: string;
	deviceName: string;
	/** True once this tab may output sound (CONTEXT.md, Activated Device). */
	isActivated: () => boolean;
	/** The Active Device did not answer a Command in time. */
	onUnresponsive?: (deviceName: string) => void;
	now?: () => number;
}

type PlayerSnapshot = ReturnType<typeof usePlayerStore.getState>;

/**
 * Keeps this tab's player and the user's Playback Session in step (CONTEXT.md, ADR 0003):
 * - as Active Device it publishes what it plays and carries out Commands;
 * - as Remote it mirrors the session into the player store, whose actions become Commands;
 * - with no Active Device it writes the session directly, and Play makes it active.
 */
export class PlaybackSync {
	private role: PlaybackRole = "local";
	private session: SessionView | null = null;
	/** Places the session's `positionAt` on this tab's clock: Remotes extrapolate from it. */
	private readonly serverClock = new ServerClock();
	private queueDoc: QueueView | null = null;
	private devices: DeviceView[] = [];
	private pending: PendingCommand[] = [];
	private readonly processed = new Set<string>();
	private outstandingSeen = new Map<string, number>();
	private readonly reported = new Set<string>();
	/** `windowStart` of the last queue window this Device published. */
	private windowStart = 0;
	private publishedQueue: PlayerSnapshot["queue"] | null = null;
	private publishTimer: ReturnType<typeof setTimeout> | null = null;
	private publishQueue = false;
	private volumeTimer: ReturnType<typeof setTimeout> | null = null;
	private volumeSendTimer: ReturnType<typeof setTimeout> | null = null;
	private volumeDirty = false;
	private volumeHoldTimer: ReturnType<typeof setTimeout> | null = null;
	private ticker: ReturnType<typeof setInterval> | null = null;
	private readonly intervals: ReturnType<typeof setInterval>[] = [];
	private readonly unsubs: (() => void)[] = [];
	/** Set while the sync itself writes the player store, so it doesn't publish its own mirror. */
	private applying = false;
	private claiming = false;
	private wasActivated = false;
	private stopped = false;
	private readonly now: () => number;

	constructor(private readonly opts: SyncOptions) {
		this.now = opts.now ?? Date.now;
	}

	get currentRole(): PlaybackRole {
		return this.role;
	}

	start() {
		const { client, deviceId } = this.opts;
		useSyncStore.getState().set({ deviceId, role: "local" });
		this.unsubs.push(
			client.watchSession((s) => this.onSession(s)),
			client.watchQueue((q) => this.onQueue(q)),
			client.watchDevices((d) => this.onDevices(d)),
			client.watchPending(deviceId, (c) => this.onPending(c)),
			client.watchOutstanding(deviceId, (c) => this.onOutstanding(c)),
			usePlayerStore.subscribe((st, prev) => this.onPlayerChange(st, prev))
		);
		this.heartbeat();
		this.intervals.push(
			setInterval(() => this.heartbeat(), HEARTBEAT_MS),
			setInterval(() => this.refreshPosition(), POSITION_REFRESH_MS),
			setInterval(() => this.checkOutstanding(), 1_000)
		);
	}

	/** Sign-out or unmount: off the picker, back to a player of its own. */
	stop() {
		if (this.stopped) return;
		this.stopped = true;
		this.unsubs.splice(0).forEach((u) => u());
		this.intervals.splice(0).forEach(clearInterval);
		if (this.publishTimer) clearTimeout(this.publishTimer);
		if (this.volumeTimer) clearTimeout(this.volumeTimer);
		if (this.volumeSendTimer) clearTimeout(this.volumeSendTimer);
		this.clearPendingVolume();
		this.stopTicker();
		void this.opts.client.leave(this.opts.deviceId).catch(() => {});
		this.setRole("local");
		useSyncStore.getState().reset();
		setRemoteVolume(null);
		this.opts.client.close();
	}

	/** The tab got its first click or key press: it can be picked for a Transfer now. */
	activationChanged() {
		if (this.opts.isActivated() !== this.wasActivated) this.heartbeat();
	}

	/**
	 * Move the sound to `targetDeviceId` (picker). Transferring here counts as this tab's activation:
	 * the heartbeat saying so goes first, and Convex runs one client's mutations in order, so the
	 * Transfer needn't wait for its answer.
	 */
	transfer(targetDeviceId: string): Promise<WriteResult> {
		if (targetDeviceId === this.opts.deviceId) void this.heartbeat();
		return this.opts.client.transfer(targetDeviceId);
	}

	// ── Session → this Device ─────────────────────────────────────────────

	private onSession(s: SessionView | null) {
		const me = this.opts.deviceId;
		this.session = s;
		if (s) this.serverClock.observe(s.positionAt, this.now());
		useSyncStore.getState().set({ activeDeviceId: s?.activeDeviceId ?? null });
		// The devices may have come first: the mute toggle starts from the new Active Device's volume.
		if (useSyncStore.getState().pendingVolume === null) {
			setRemoteVolume(this.devices.find((d) => d.deviceId === s?.activeDeviceId)?.volume ?? null);
		}

		if (!s) {
			// Nobody ever wrote a session: this Device's own player seeds it.
			this.setRole("idle");
			const local = usePlayerStore.getState();
			if (local.isPlaying && local.currentTrack) void this.claim();
			else if (local.currentTrack) this.schedulePublish(true);
			return;
		}

		if (s.activeDeviceId === me) {
			if (this.role !== "active") {
				// A Transfer made this Device active: it takes over the session as it stands, queue
				// included, so there is no need to publish that queue again.
				if (s.updatedBy !== me) this.mirror();
				this.publishedQueue = usePlayerStore.getState().queue;
				this.windowStart = this.queueDoc?.windowStart ?? 0;
				this.setRole("active");
			}
			return;
		}

		if (s.activeDeviceId === null) {
			if (this.role === "active") {
				// Dropped while still playing here (missed heartbeats): back if nobody took over.
				void this.reclaim();
				return;
			}
			this.setRole("idle");
			const local = usePlayerStore.getState();
			if (local.isPlaying && local.currentTrack) void this.claim();
			else if (s.updatedBy !== me) this.mirror();
			return;
		}

		// Another Device plays: this one is a Remote and falls silent (AudioEngine follows the role).
		this.setRole("remote");
		this.mirror();
	}

	private onQueue(q: QueueView | null) {
		this.queueDoc = q;
		if (this.role === "active" || !q) return;
		if (this.session?.updatedBy === this.opts.deviceId && this.role === "idle") return;
		this.write({ queue: q.tracks.map(toPlayerTrack) });
	}

	private onDevices(devices: DeviceView[]) {
		// The latest heartbeat (this tab's own, just after it sends one) tells the server's time.
		if (devices.length) this.serverClock.observe(Math.max(...devices.map((d) => d.lastSeen)), this.now());
		this.devices = devices;
		useSyncStore.getState().set({ devices });
		const active = devices.find((d) => d.deviceId === this.session?.activeDeviceId);
		// Mid-drag, the heartbeats lag behind what was just set here.
		if (useSyncStore.getState().pendingVolume === null) setRemoteVolume(active?.volume ?? null);
	}

	/**
	 * Like Spotify Connect: the slider follows the finger at once, the Active Device gets a Command
	 * at most every VOLUME_THROTTLE_MS (the last value always goes out), and its own reports, a step
	 * behind during a drag, don't pull the slider back for VOLUME_HOLD_MS.
	 */
	private setRemoteVolumeTo(volume: number) {
		const v = Math.max(0, Math.min(1, volume));
		useSyncStore.getState().set({ pendingVolume: v });
		setRemoteVolume(v);
		if (this.volumeHoldTimer) clearTimeout(this.volumeHoldTimer);
		this.volumeHoldTimer = setTimeout(() => {
			this.clearPendingVolume();
			const active = this.devices.find((d) => d.deviceId === this.session?.activeDeviceId);
			setRemoteVolume(active?.volume ?? null);
		}, VOLUME_HOLD_MS);
		if (this.volumeSendTimer) {
			this.volumeDirty = true;
			return;
		}
		this.sendVolume();
	}

	private sendVolume() {
		const v = useSyncStore.getState().pendingVolume;
		if (v === null) return;
		this.volumeDirty = false;
		this.sendCommand({ type: "setVolume", volume: v });
		this.volumeSendTimer = setTimeout(() => {
			this.volumeSendTimer = null;
			if (this.volumeDirty) this.sendVolume();
		}, VOLUME_THROTTLE_MS);
	}

	private clearPendingVolume() {
		if (this.volumeHoldTimer) clearTimeout(this.volumeHoldTimer);
		this.volumeHoldTimer = null;
		this.volumeDirty = false;
		if (useSyncStore.getState().pendingVolume !== null) useSyncStore.getState().set({ pendingVolume: null });
	}

	/** Copies the session into the player store (Remote, idle, or right after a Transfer here). */
	private mirror() {
		const s = this.session;
		if (!s) return;
		const { state } = s;
		const position = this.position(state, s.positionAt);
		const local = usePlayerStore.getState();
		const queue = this.queueDoc ? this.queueDoc.tracks.map(toPlayerTrack) : local.queue;
		const currentTrack = state.currentTrack ? toPlayerTrack(state.currentTrack) : null;
		const sameTrack = local.currentTrack?.trackId === currentTrack?.trackId;
		this.write({
			queue,
			queueIndex: state.index,
			currentTrack: sameTrack && local.currentTrack ? local.currentTrack : currentTrack,
			isPlaying: state.isPlaying,
			currentTime: position,
			duration: currentTrack?.duration ?? (sameTrack ? local.duration : 0),
			shuffle: state.shuffle,
			repeat: state.repeat,
			isBuffering: false,
			error: null,
			// With no Active Device this tab's own engine holds the track: have it start where the
			// session is when Play is pressed here.
			...(this.role === "idle" && currentTrack && position > 0 && (!sameTrack || Math.abs(position - local.currentTime) > 2)
				? { _seekTo: position }
				: {}),
		});
		this.updateTicker();
	}

	/** Where the session's position, true at server time `positionAt`, is now (seconds). */
	private position(state: SessionView["state"], positionAt: number): number {
		return extrapolate(state, this.serverClock.toLocal(positionAt), this.now());
	}

	private write(patch: Partial<PlayerSnapshot>) {
		this.applying = true;
		try {
			usePlayerStore.setState(patch);
		} finally {
			this.applying = false;
		}
	}

	// ── This Device → session ─────────────────────────────────────────────

	private onPlayerChange(st: PlayerSnapshot, prev: PlayerSnapshot) {
		if (this.applying || this.stopped) return;
		if (this.role === "active") {
			if (st.volume !== prev.volume) this.volumeChanged();
			if (changed(st, prev)) this.schedulePublish(st.queue !== prev.queue);
			return;
		}
		if (this.role !== "idle") return;
		if (!prev.isPlaying && st.isPlaying && st.currentTrack) {
			void this.claim();
			return;
		}
		if (changed(st, prev)) this.schedulePublish(st.queue !== prev.queue);
	}

	private local() {
		const p = usePlayerStore.getState();
		return toSession(p);
	}

	private schedulePublish(withQueue: boolean) {
		this.publishQueue ||= withQueue;
		if (this.publishTimer) return;
		this.publishTimer = setTimeout(() => {
			this.publishTimer = null;
			void this.flushPublish();
		}, PUBLISH_DEBOUNCE_MS);
	}

	private async flushPublish() {
		if (this.stopped || (this.role !== "active" && this.role !== "idle")) return;
		const { state, queue } = this.local();
		const player = usePlayerStore.getState();
		const withQueue =
			this.publishQueue || queue.windowStart !== this.windowStart || player.queue !== this.publishedQueue;
		this.publishQueue = false;
		if (withQueue) {
			this.windowStart = queue.windowStart;
			this.publishedQueue = player.queue;
		}
		try {
			await this.opts.client.publish({
				deviceId: this.opts.deviceId,
				state,
				...(withQueue ? { queue } : {}),
			});
		} catch {
			// Offline: the next change or position refresh publishes again.
			if (withQueue) this.publishedQueue = null;
		}
	}

	/** The Active Device corrects the position Remotes extrapolate. */
	private refreshPosition() {
		if (this.role === "active" && usePlayerStore.getState().isPlaying) this.schedulePublish(false);
	}

	/** Play pressed with no Active Device: become it. Refused → the Play goes to whoever won. */
	private async claim() {
		if (this.claiming) return;
		this.claiming = true;
		const { state, queue } = this.local();
		try {
			const res = await this.opts.client.claim({ deviceId: this.opts.deviceId, state, queue });
			if (res.ok) {
				this.windowStart = queue.windowStart;
				this.publishedQueue = usePlayerStore.getState().queue;
				this.setRole("active");
			} else if ("activeDeviceId" in res && res.activeDeviceId) {
				// Another Device got there first: this tab is a Remote and asks it to play this.
				this.setRole("remote");
				if (state.currentTrack) {
					this.sendCommand({ type: "playQueue", tracks: queue.tracks, startIndex: Math.max(0, state.index) });
				}
			}
		} catch {
			// Not reached: keep playing here; the reconnect's session snapshot sorts it out.
		} finally {
			this.claiming = false;
		}
	}

	private async reclaim() {
		const { state, queue } = this.local();
		try {
			const res = await this.opts.client.reclaim({ deviceId: this.opts.deviceId, state, queue });
			if ("activeDeviceId" in res) {
				// Someone else plays now: this Device stops and becomes a Remote, or idle.
				this.setRole(res.activeDeviceId ? "remote" : "idle");
				this.mirror();
			}
		} catch {
			// Retried on the next session snapshot.
		}
	}

	// ── Commands ──────────────────────────────────────────────────────────

	private onPending(commands: PendingCommand[]) {
		this.pending = commands;
		if (this.role === "active") this.runPending();
	}

	/** Carries out the Commands waiting for this Device, once each, in order, then acks them. */
	private runPending() {
		const ids: string[] = [];
		for (const c of this.pending) {
			ids.push(c.id);
			if (this.processed.has(c.id)) continue;
			this.processed.add(c.id);
			executeCommand(c.command, this.windowStart);
		}
		if (ids.length) void this.opts.client.ack(this.opts.deviceId, ids).catch(() => {});
	}

	private sendCommand(command: Command) {
		this.opts.client
			.send(this.opts.deviceId, command)
			.then((res) => {
				if (!("reason" in res)) return;
				// Nobody plays (or this Device does, after all): carry the action out here.
				this.setRole(res.reason === "is-active" ? "active" : "idle");
				executeCommand(command);
			})
			.catch(() => {});
	}

	private onOutstanding(commands: OutstandingCommand[]) {
		const seen = new Map<string, number>();
		for (const c of commands) seen.set(c.id, this.outstandingSeen.get(c.id) ?? this.now());
		this.outstandingSeen = seen;
	}

	private checkOutstanding() {
		if (this.role !== "remote") return;
		const now = this.now();
		for (const [id, since] of this.outstandingSeen) {
			if (now - since < UNRESPONSIVE_MS || this.reported.has(id)) continue;
			this.reported.add(id);
			const target = this.devices.find((d) => d.deviceId === this.session?.activeDeviceId);
			this.opts.onUnresponsive?.(target?.name ?? "The other device");
			return;
		}
	}

	// ── Role, heartbeat, ticker ───────────────────────────────────────────

	private setRole(role: PlaybackRole) {
		if (this.role === role) return;
		const was = this.role;
		this.role = role;
		setRemoteSender(
			role === "remote" ? (c) => (c.type === "setVolume" ? this.setRemoteVolumeTo(c.volume) : this.sendCommand(c)) : null
		);
		// A volume set for another Device means nothing once this one plays or nobody does.
		this.clearPendingVolume();
		useSyncStore.getState().set({ role });
		this.updateTicker();
		if (role === "active") this.runPending();
		if (role === "active" || was === "active") this.heartbeat();
	}

	private heartbeat(): Promise<void> {
		if (this.stopped) return Promise.resolve();
		const activated = this.opts.isActivated();
		this.wasActivated = activated;
		const volume = this.role === "active" ? usePlayerStore.getState().volume / 100 : undefined;
		return this.opts.client
			.heartbeat({
				deviceId: this.opts.deviceId,
				name: this.opts.deviceName,
				platform: "web",
				activated,
				...(volume !== undefined ? { volume } : {}),
			})
			.catch(() => {});
	}

	/** Remotes show the Active Device's volume: tell them soon after it changes. */
	private volumeChanged() {
		if (this.volumeTimer) clearTimeout(this.volumeTimer);
		this.volumeTimer = setTimeout(() => {
			this.volumeTimer = null;
			void this.heartbeat();
		}, 300);
	}

	private updateTicker() {
		const want = this.role === "remote" && !!this.session?.state.isPlaying;
		if (want && !this.ticker) {
			this.ticker = setInterval(() => {
				const s = this.session;
				if (!s) return;
				this.write({ currentTime: this.position(s.state, s.positionAt) });
			}, TICK_MS);
		} else if (!want) {
			this.stopTicker();
		}
	}

	private stopTicker() {
		if (this.ticker) clearInterval(this.ticker);
		this.ticker = null;
	}
}

/** Whether a store change is part of the Playback Session (not the engine's own bookkeeping). */
function changed(st: PlayerSnapshot, prev: PlayerSnapshot): boolean {
	return (
		st.queue !== prev.queue ||
		st.queueIndex !== prev.queueIndex ||
		st.currentTrack?.trackId !== prev.currentTrack?.trackId ||
		st.isPlaying !== prev.isPlaying ||
		st.shuffle !== prev.shuffle ||
		st.repeat !== prev.repeat ||
		(st._seekTo !== null && st._seekTo !== prev._seekTo)
	);
}
