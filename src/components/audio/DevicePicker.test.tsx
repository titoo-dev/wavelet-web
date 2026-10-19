import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { error: vi.fn() }) }));

import { toast } from "sonner";
import { DevicePicker, PlayingOn } from "./DevicePicker";
import { setPlaybackSync } from "@/lib/playback-sync/instance";
import type { PlaybackSync } from "@/lib/playback-sync/sync";
import type { DeviceView, WriteResult } from "@/lib/playback-sync/types";
import { useShownVolume, useSyncStore } from "@/lib/playback-sync/useSyncStore";
import { usePlayerStore } from "@/stores/usePlayerStore";

const device = (deviceId: string, over: Partial<DeviceView> = {}): DeviceView => ({
	deviceId,
	name: deviceId,
	platform: "web",
	activated: true,
	volume: null,
	lastSeen: 0,
	...over,
});

let transfer: ReturnType<typeof vi.fn<(id: string) => Promise<WriteResult>>>;

beforeEach(() => {
	transfer = vi.fn(async () => ({ ok: true, queueVersion: 1 }) as WriteResult);
	setPlaybackSync({ transfer } as unknown as PlaybackSync);
	useSyncStore.getState().set({
		role: "remote",
		deviceId: "me",
		activeDeviceId: "phone",
		devices: [
			device("me", { name: "Chrome · Windows" }),
			device("phone", { name: "Pixel 8", platform: "android", volume: 0.3 }),
			device("other-tab", { name: "Firefox · Linux", activated: false }),
		],
	});
});

afterEach(() => {
	setPlaybackSync(null);
	useSyncStore.getState().reset();
});

describe("DevicePicker", () => {
	it("is hidden while the player runs on its own (signed out / not configured)", () => {
		useSyncStore.getState().reset();
		render(<DevicePicker />);
		expect(screen.queryByRole("button", { name: /device/i })).toBeNull();
	});

	it("lists the Devices, the one playing first and checked, this one marked", async () => {
		render(<DevicePicker />);
		await userEvent.click(screen.getByRole("button", { name: "Playing on Pixel 8. Choose a device" }));
		const items = await screen.findAllByRole("menuitemradio");
		expect(items.map((i) => i.textContent)).toEqual([
			"Pixel 8Playing",
			"Chrome · Windows · This device",
			"Firefox · LinuxClick anywhere in that window to use it",
		]);
		expect(items[0]).toHaveAttribute("aria-checked", "true");
		expect(items[2]).toHaveAttribute("aria-disabled", "true");
	});

	it("picking a Device transfers the sound to it", async () => {
		render(<DevicePicker />);
		await userEvent.click(screen.getByRole("button", { name: /Choose a device/ }));
		await userEvent.click(await screen.findByRole("menuitemradio", { name: /This device/ }));
		await waitFor(() => expect(transfer).toHaveBeenCalledWith("me"));
	});

	it("says why a Transfer was refused", async () => {
		transfer.mockResolvedValueOnce({ ok: false, reason: "offline", activeDeviceId: "phone" });
		render(<DevicePicker />);
		await userEvent.click(screen.getByRole("button", { name: /Choose a device/ }));
		await userEvent.click(await screen.findByRole("menuitemradio", { name: /This device/ }));
		await waitFor(() => expect(toast.error).toHaveBeenCalledWith("That device is offline"));
	});

	it("says so when the Transfer could not be sent", async () => {
		transfer.mockRejectedValueOnce(new Error("offline"));
		render(<DevicePicker />);
		await userEvent.click(screen.getByRole("button", { name: /Choose a device/ }));
		await userEvent.click(await screen.findByRole("menuitemradio", { name: /This device/ }));
		await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Couldn't switch devices. Check your connection."));
	});

	it("names the plain trigger when this Device plays", () => {
		useSyncStore.getState().set({ role: "active", activeDeviceId: "me" });
		render(<DevicePicker />);
		expect(screen.getByRole("button", { name: "Choose a device" })).toBeInTheDocument();
	});
});

describe("PlayingOn", () => {
	it("names the Device that plays while this one is a Remote", () => {
		render(<PlayingOn />);
		expect(screen.getByText("Playing on Pixel 8")).toBeInTheDocument();
	});

	it("shows nothing when this Device plays", () => {
		useSyncStore.getState().set({ role: "active", activeDeviceId: "me" });
		const { container } = render(<PlayingOn />);
		expect(container).toBeEmptyDOMElement();
	});
});

describe("useShownVolume", () => {
	function Shown() {
		return <span>{useShownVolume()}</span>;
	}

	it("shows the Active Device's volume on a Remote, this one's otherwise", () => {
		usePlayerStore.setState({ volume: 80 });
		const { rerender } = render(<Shown />);
		expect(screen.getByText("30")).toBeInTheDocument();
		useSyncStore.getState().set({ role: "active", activeDeviceId: "me" });
		rerender(<Shown />);
		expect(screen.getByText("80")).toBeInTheDocument();
	});
});
