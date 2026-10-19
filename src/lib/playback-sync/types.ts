// The Playback Session as the clients see it (convex/validators.ts, CONTEXT.md). Plain types so
// the sync logic can be tested without a Convex backend.
import type { Command, PlaybackState, Queue, Track } from "../../../convex/validators";

export type { Command, PlaybackState, Queue, Track };

/**
 * What this Device is to the Playback Session:
 * - `local`: no sync (signed out, Convex not configured or not reached yet): the player works alone;
 * - `idle`: no Active Device: changes go to the session directly, Play makes this Device active;
 * - `active`: this Device outputs the sound and is the only one publishing;
 * - `remote`: another Device plays; actions here are Commands to it.
 */
export type PlaybackRole = "local" | "idle" | "active" | "remote";

export interface SessionView {
	activeDeviceId: string | null;
	lastActiveDeviceId: string | null;
	state: PlaybackState;
	positionAt: number;
	queueVersion: number;
	updatedBy: string | null;
}

export interface QueueView extends Queue {
	version: number;
}

export interface DeviceView {
	deviceId: string;
	name: string;
	platform: "web" | "android" | "ios";
	activated: boolean;
	volume: number | null;
	lastSeen: number;
}

export interface PendingCommand {
	id: string;
	command: Command;
	fromDeviceId: string;
	createdAt: number;
}

export interface OutstandingCommand {
	id: string;
	targetDeviceId: string;
	createdAt: number;
}

export type WriteResult =
	| { ok: true; queueVersion: number }
	| { ok: false; reason: "not-active" | "offline" | "not-activated" | "unknown-device"; activeDeviceId: string | null };

export type SendResult =
	| { ok: true; id: string; targetDeviceId: string }
	| { ok: false; reason: "no-active" | "is-active" };

export interface HeartbeatArgs {
	deviceId: string;
	name: string;
	platform: "web";
	activated: boolean;
	volume?: number;
}

export interface PublishArgs {
	deviceId: string;
	state: PlaybackState;
	queue?: Queue;
}

type Unsubscribe = () => void;

/** The Convex functions the sync needs, behind an interface (real one: `convex-client.ts`). */
export interface SyncClient {
	watchSession(cb: (s: SessionView | null) => void): Unsubscribe;
	watchQueue(cb: (q: QueueView | null) => void): Unsubscribe;
	watchDevices(cb: (d: DeviceView[]) => void): Unsubscribe;
	watchPending(deviceId: string, cb: (c: PendingCommand[]) => void): Unsubscribe;
	watchOutstanding(deviceId: string, cb: (c: OutstandingCommand[]) => void): Unsubscribe;
	heartbeat(args: HeartbeatArgs): Promise<void>;
	leave(deviceId: string): Promise<void>;
	/** `leave` from a page that is going away, when the socket may not get a mutation out. */
	leaveOnUnload(deviceId: string): void;
	publish(args: PublishArgs): Promise<WriteResult>;
	claim(args: PublishArgs): Promise<WriteResult>;
	reclaim(args: PublishArgs): Promise<WriteResult>;
	transfer(targetDeviceId: string): Promise<WriteResult>;
	send(fromDeviceId: string, command: Command): Promise<SendResult>;
	ack(deviceId: string, ids: string[]): Promise<void>;
	close(): void;
}
