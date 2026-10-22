"use client";

import { create } from "zustand";
import { usePlayerStore } from "@/stores/usePlayerStore";
import type { DeviceView, PlaybackRole } from "./types";

/** What the UI shows of the multi-device state: this Device's role, the picker, who plays. */
interface SyncState {
	role: PlaybackRole;
	deviceId: string | null;
	devices: DeviceView[];
	activeDeviceId: string | null;
	/** The volume (0..1) a Remote just set, shown until the Active Device has had time to report it. */
	pendingVolume: number | null;
	set: (patch: Partial<Omit<SyncState, "set">>) => void;
	reset: () => void;
}

const initial = {
	role: "local" as PlaybackRole,
	deviceId: null,
	devices: [],
	activeDeviceId: null,
	pendingVolume: null,
};

export const useSyncStore = create<SyncState>()((set) => ({
	...initial,
	set: (patch) => set(patch),
	reset: () => set(initial),
}));

/** The Device that plays, when it is another one (this Device is then a Remote). */
export function useRemoteActiveDevice(): DeviceView | null {
	return useSyncStore((s) =>
		s.role === "remote" ? (s.devices.find((d) => d.deviceId === s.activeDeviceId) ?? null) : null
	);
}

/** A Remote's volume (0..1): the one just set here, else the Active Device's; null otherwise. */
function remoteVolumeOf(s: Pick<SyncState, "role" | "devices" | "activeDeviceId" | "pendingVolume">): number | null {
	if (s.role !== "remote") return null;
	return s.pendingVolume ?? s.devices.find((d) => d.deviceId === s.activeDeviceId)?.volume ?? null;
}

/**
 * The volume the player shows (0..100): the Active Device's while this Device is a Remote, like
 * Spotify Connect. Steps (wheel, Shift+arrows) start from it.
 */
export function useShownVolume(): number {
	const local = usePlayerStore((s) => s.volume);
	const remote = useSyncStore(remoteVolumeOf);
	return remote !== null ? Math.round(remote * 100) : local;
}

/** `useShownVolume` outside React. */
export function shownVolume(): number {
	const remote = remoteVolumeOf(useSyncStore.getState());
	return remote !== null ? Math.round(remote * 100) : usePlayerStore.getState().volume;
}
