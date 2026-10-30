import { describe, it, expect, beforeEach, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("@/utils/haptic", () => ({ haptic: vi.fn() }));

import { usePlayerStore } from "@/stores/usePlayerStore";
import { DEFAULT_SOUND, EQ_PRESETS } from "@/components/audio/engine/sound";
import { EqualizerTile, SpatialTile } from "./SoundTiles";

const INITIAL = usePlayerStore.getState();

beforeEach(() => usePlayerStore.setState(INITIAL, true));

describe("SpatialTile", () => {
	it("shows Off by default and switches mode from the segments", async () => {
		render(<SpatialTile />);
		expect(screen.getByRole("tab", { name: "Off" })).toHaveAttribute("aria-selected", "true");
		await userEvent.click(screen.getByRole("tab", { name: "Hall" }));
		expect(usePlayerStore.getState().sound.spatial).toBe("hall");
		expect(screen.getByText("A large, airy hall around you.")).toBeInTheDocument();
	});
});

describe("EqualizerTile", () => {
	it("opens on a click, picks a preset and shows its curve on the sliders", async () => {
		render(<EqualizerTile />);
		expect(screen.getByText("Flat: the sound as mastered.")).toBeInTheDocument();
		await userEvent.click(screen.getByRole("button", { name: /Equalizer/ }));
		await userEvent.click(screen.getByRole("tab", { name: "Bass" }));
		expect(usePlayerStore.getState().sound.eqPreset).toBe("bass");
		expect(screen.getByRole("slider", { name: "31 Hz" })).toHaveValue(String(EQ_PRESETS.bass[0]));
		expect(screen.getByText("Bass curve")).toBeInTheDocument();
	});

	it("moving a slider makes the curve custom; Reset goes back to flat", async () => {
		render(<EqualizerTile />);
		await userEvent.click(screen.getByRole("button", { name: /Equalizer/ }));
		fireEvent.change(screen.getByRole("slider", { name: "1k Hz" }), { target: { value: "4.5" } });
		const { sound } = usePlayerStore.getState();
		expect(sound.eqPreset).toBe("custom");
		expect(sound.eqCustom[5]).toBe(4.5);
		expect(screen.getByRole("tab", { name: "Custom" })).toHaveAttribute("aria-selected", "true");
		await userEvent.click(screen.getByRole("button", { name: "Reset" }));
		expect(usePlayerStore.getState().sound.eqPreset).toBe(DEFAULT_SOUND.eqPreset);
	});
});
