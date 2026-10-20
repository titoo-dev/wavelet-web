"use client";

import { Laptop, MonitorSpeaker, Smartphone } from "lucide-react";
import { toast } from "sonner";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuLabel,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { getPlaybackSync } from "@/lib/playback-sync/instance";
import { useRemoteActiveDevice, useSyncStore } from "@/lib/playback-sync/useSyncStore";
import type { DeviceView, WriteResult } from "@/lib/playback-sync/types";
import { cn } from "@/lib/utils";

const REFUSALS: Record<Exclude<WriteResult, { ok: true }>["reason"], string> = {
	offline: "That device is offline",
	"unknown-device": "That device is gone",
	"not-active": "Another device took over",
};

function DeviceIcon({ device, className }: { device: Pick<DeviceView, "platform">; className?: string }) {
	const Icon = device.platform === "web" ? Laptop : Smartphone;
	return <Icon className={cn("size-4", className)} aria-hidden />;
}

/** Transfers the sound to `deviceId` (CONTEXT.md, Transfer); says why when it can't. */
export async function transferTo(deviceId: string) {
	const sync = getPlaybackSync();
	if (!sync) return;
	try {
		const res = await sync.transfer(deviceId);
		if ("reason" in res) toast.error(REFUSALS[res.reason]);
	} catch {
		toast.error("Couldn't switch devices. Check your connection.");
	}
}

/**
 * The device picker: every Online Device of the user, the one playing checked. Hidden while the
 * player runs on its own (signed out, or multi-device not configured).
 */
export function DevicePicker({ className, side = "top" }: { className?: string; side?: "top" | "bottom" }) {
	const role = useSyncStore((s) => s.role);
	const devices = useSyncStore((s) => s.devices);
	const me = useSyncStore((s) => s.deviceId);
	const activeDeviceId = useSyncStore((s) => s.activeDeviceId);
	const remoteActive = useRemoteActiveDevice();
	if (role === "local") return null;

	// Speakers start at the Device that plays, then this one, then the rest by name.
	const sorted = [...devices].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
	function rank(d: DeviceView) {
		return d.deviceId === activeDeviceId ? 0 : d.deviceId === me ? 1 : 2;
	}

	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				aria-label={remoteActive ? `Playing on ${remoteActive.name}. Choose a device` : "Choose a device"}
				title="Devices"
				className={cn(className, remoteActive && "bg-primary/12 text-primary hover:bg-primary/18 hover:text-primary")}
			>
				<MonitorSpeaker className="size-[18px]" />
			</DropdownMenuTrigger>
			<DropdownMenuContent side={side} align="end" sideOffset={16} className="w-72 rounded-2xl p-1.5">
				<DropdownMenuGroup>
					<DropdownMenuLabel className="px-2.5 text-[11px] font-semibold uppercase tracking-[0.12em] text-primary">
						Play on
					</DropdownMenuLabel>
					<DropdownMenuRadioGroup value={activeDeviceId ?? ""} onValueChange={(id) => void transferTo(String(id))}>
						{sorted.map((d) => (
							<DropdownMenuRadioItem
								key={d.deviceId}
								value={d.deviceId}
								className="items-start gap-2.5 rounded-xl px-2.5 py-2"
							>
								<DeviceIcon device={d} className="mt-0.5" />
								<span className="flex min-w-0 flex-col">
									<span className="truncate font-medium">
										{d.name}
										{d.deviceId === me && <span className="text-muted-foreground"> · This device</span>}
									</span>
									{!d.activated && d.deviceId !== me && (
										<span className="text-xs text-muted-foreground">May ask for a click in that window to play</span>
									)}
									{d.deviceId === activeDeviceId && <span className="text-xs text-primary">Playing</span>}
								</span>
							</DropdownMenuRadioItem>
						))}
					</DropdownMenuRadioGroup>
				</DropdownMenuGroup>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

/** "Playing on Pixel 8" while another Device plays, for the player's subtitle row. */
export function PlayingOn({ className }: { className?: string }) {
	const device = useRemoteActiveDevice();
	if (!device) return null;
	return (
		<span className={cn("inline-flex min-w-0 items-center gap-1 text-primary", className)}>
			<DeviceIcon device={device} className="size-3" />
			<span className="truncate">Playing on {device.name}</span>
		</span>
	);
}
