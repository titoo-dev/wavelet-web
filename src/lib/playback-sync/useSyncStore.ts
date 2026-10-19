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
	set: (patch: Partial<Omit<SyncState, "set">>) => void;
	reset: () => void;
}

const initial = { role: "local" as PlaybackRole, deviceId: null, devices: [], activeDeviceId: null };

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

/** The volume the player shows (0..100): the Active Device's while this Device is a Remote. */
export function useShownVolume(): number {
	const local = usePlayerStore((s) => s.volume);
	const remote = useSyncStore((s) =>
		s.role === "remote" ? (s.devices.find((d) => d.deviceId === s.activeDeviceId)?.volume ?? null) : null
	);
	return remote !== null ? Math.round(remote * 100) : local;
}
