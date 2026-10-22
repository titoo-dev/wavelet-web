import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { useKeyboardShortcuts } from "./useKeyboardShortcuts";
import { useCommandStore } from "@/stores/useCommandStore";
import { usePlayerStore } from "@/stores/usePlayerStore";
import { useLyricsStore } from "@/stores/useLyricsStore";
import { setRemoteSender } from "@/lib/playback-sync/remote";
import { useSyncStore } from "@/lib/playback-sync/useSyncStore";

const CMD = useCommandStore.getState();
const PLAYER = usePlayerStore.getState();

function press(key: string, init: KeyboardEventInit = {}, target: EventTarget = document.body) {
	const e = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
	target.dispatchEvent(e);
	return e;
}

const track = { trackId: "1", title: "t", artist: "a", cover: null, duration: 100 };

beforeEach(() => {
	useCommandStore.setState(CMD, true);
	usePlayerStore.setState(PLAYER, true);
});

describe("useKeyboardShortcuts — command palette", () => {
	it("⌘K and Ctrl+K toggle the palette", () => {
		renderHook(() => useKeyboardShortcuts());
		const e = press("k", { metaKey: true });
		expect(e.defaultPrevented).toBe(true);
		expect(useCommandStore.getState().isOpen).toBe(true);
		press("K", { ctrlKey: true });
		expect(useCommandStore.getState().isOpen).toBe(false);
	});

	it("⌘K works even while typing in an input", () => {
		renderHook(() => useKeyboardShortcuts());
		const input = document.createElement("input");
		document.body.appendChild(input);
		press("k", { metaKey: true }, input);
		expect(useCommandStore.getState().isOpen).toBe(true);
		input.remove();
	});

	it("'/' opens the palette outside inputs", () => {
		renderHook(() => useKeyboardShortcuts());
		press("/");
		expect(useCommandStore.getState().isOpen).toBe(true);
	});

	it("player shortcuts are ignored while the palette is open", () => {
		usePlayerStore.setState({ currentTrack: track, isPlaying: true });
		useCommandStore.setState({ isOpen: true });
		renderHook(() => useKeyboardShortcuts());
		press(" ");
		expect(usePlayerStore.getState().isPlaying).toBe(true);
	});

	it("space still toggles playback when the palette is closed", () => {
		usePlayerStore.setState({ currentTrack: track, isPlaying: true });
		renderHook(() => useKeyboardShortcuts());
		press(" ");
		expect(usePlayerStore.getState().isPlaying).toBe(false);
	});

	it("modified keys are left to the browser (was: Ctrl+Arrow skipped tracks)", () => {
		usePlayerStore.setState({ currentTrack: track, isPlaying: true, volume: 50 });
		renderHook(() => useKeyboardShortcuts());
		const e = press("ArrowUp", { altKey: true });
		expect(e.defaultPrevented).toBe(false);
		expect(usePlayerStore.getState().volume).toBe(50);
	});
});

describe("useKeyboardShortcuts — page scrolling (NAV-01)", () => {
	it("leaves Space to the browser when nothing is loaded (was: Space never scrolled the page)", () => {
		renderHook(() => useKeyboardShortcuts());
		const e = press(" ");
		expect(e.defaultPrevented).toBe(false);
	});

	it("leaves ArrowUp / ArrowDown to the browser (was: arrows changed the volume instead of scrolling)", () => {
		usePlayerStore.setState({ currentTrack: track, isPlaying: true, volume: 50 });
		renderHook(() => useKeyboardShortcuts());
		const up = press("ArrowUp");
		const down = press("ArrowDown");
		expect(up.defaultPrevented).toBe(false);
		expect(down.defaultPrevented).toBe(false);
		expect(usePlayerStore.getState().volume).toBe(50);
	});

	it("Shift+ArrowUp on a Remote steps the Active Device's volume (was: from this tab's own, a jump)", () => {
		const sent: unknown[] = [];
		setRemoteSender((c) => sent.push(c));
		useSyncStore.getState().set({
			role: "remote",
			activeDeviceId: "phone",
			devices: [{ deviceId: "phone", name: "Pixel", platform: "android", activated: true, volume: 0.2, lastSeen: 0 }],
		});
		usePlayerStore.setState({ currentTrack: track, isPlaying: true, volume: 80 });
		renderHook(() => useKeyboardShortcuts());
		press("ArrowUp", { shiftKey: true });
		expect(sent).toEqual([{ type: "setVolume", volume: 0.25 }]);
		setRemoteSender(null);
		useSyncStore.getState().reset();
	});

	it("Shift+ArrowUp / Shift+ArrowDown change the volume", () => {
		usePlayerStore.setState({ currentTrack: track, isPlaying: true, volume: 50 });
		renderHook(() => useKeyboardShortcuts());
		const up = press("ArrowUp", { shiftKey: true });
		expect(up.defaultPrevented).toBe(true);
		expect(usePlayerStore.getState().volume).toBe(55);
		press("ArrowDown", { shiftKey: true });
		expect(usePlayerStore.getState().volume).toBe(50);
	});

	it("leaves ArrowLeft / ArrowRight to the browser when nothing is loaded (was: horizontal scroll blocked)", () => {
		renderHook(() => useKeyboardShortcuts());
		expect(press("ArrowLeft").defaultPrevented).toBe(false);
		expect(press("ArrowRight").defaultPrevented).toBe(false);
	});
});

describe("useKeyboardShortcuts — palette Escape fallback (NAV-18)", () => {
	it("Escape closes the palette even when the focus left it (was: the palette ignored the keyboard)", () => {
		useCommandStore.setState({ isOpen: true });
		renderHook(() => useKeyboardShortcuts());
		press("Escape");
		expect(useCommandStore.getState().isOpen).toBe(false);
	});

	it("leaves an Escape the palette already handled alone", () => {
		useCommandStore.setState({ isOpen: true });
		renderHook(() => useKeyboardShortcuts());
		const e = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
		e.preventDefault();
		document.body.dispatchEvent(e);
		expect(useCommandStore.getState().isOpen).toBe(true);
	});
});

function mount<T extends HTMLElement>(el: T): T {
	document.body.appendChild(el);
	return el;
}

const queue3 = [track, { ...track, trackId: "2" }, { ...track, trackId: "3" }];

afterEach(() => {
	document.body.innerHTML = "";
	useLyricsStore.setState({ immersiveOpen: false });
});

describe("useKeyboardShortcuts — keys a focused control owns (HK-01, HK-02, HK-07)", () => {
	it("leaves Space to a focused button (was: Space paused the track instead of clicking the button)", () => {
		usePlayerStore.setState({ currentTrack: track, isPlaying: true });
		renderHook(() => useKeyboardShortcuts());
		const button = mount(document.createElement("button"));
		const e = press(" ", {}, button);
		expect(e.defaultPrevented).toBe(false);
		expect(usePlayerStore.getState().isPlaying).toBe(true);
	});

	it("leaves Space to a link and to a role=button element", () => {
		usePlayerStore.setState({ currentTrack: track, isPlaying: true });
		renderHook(() => useKeyboardShortcuts());
		const link = mount(document.createElement("a"));
		link.href = "/album?id=1";
		const row = mount(document.createElement("div"));
		row.setAttribute("role", "button");
		expect(press(" ", {}, link).defaultPrevented).toBe(false);
		expect(press(" ", {}, row).defaultPrevented).toBe(false);
		expect(usePlayerStore.getState().isPlaying).toBe(true);
	});

	it("still skips tracks with the arrows while a button has the focus", () => {
		usePlayerStore.setState({ currentTrack: track, isPlaying: true, queue: queue3, queueIndex: 0 });
		renderHook(() => useKeyboardShortcuts());
		const button = mount(document.createElement("button"));
		press("ArrowRight", {}, button);
		expect(usePlayerStore.getState().queueIndex).toBe(1);
	});

	it("ignores a key a component already handled (was: Space on a queue row jumped to the track, then paused it)", () => {
		usePlayerStore.setState({ currentTrack: track, isPlaying: true });
		renderHook(() => useKeyboardShortcuts());
		const e = new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true });
		e.preventDefault();
		document.body.dispatchEvent(e);
		expect(usePlayerStore.getState().isPlaying).toBe(true);
	});

	it("leaves the arrows to a radio option (was: Settings › Quality arrows skipped tracks)", () => {
		usePlayerStore.setState({ currentTrack: track, isPlaying: true, queue: queue3, queueIndex: 0 });
		renderHook(() => useKeyboardShortcuts());
		const radio = mount(document.createElement("button"));
		radio.setAttribute("role", "radio");
		expect(press("ArrowRight", {}, radio).defaultPrevented).toBe(false);
		expect(usePlayerStore.getState().queueIndex).toBe(0);
	});

	it("leaves every key to a native <select>", () => {
		usePlayerStore.setState({ currentTrack: track, isPlaying: true, volume: 50 });
		renderHook(() => useKeyboardShortcuts());
		const select = mount(document.createElement("select"));
		press("m", {}, select);
		expect(usePlayerStore.getState().volume).toBe(50);
	});
});

describe("useKeyboardShortcuts — dialogs and menus (HK-05)", () => {
	function layer(role: string, attrs: Record<string, string> = {}) {
		const host = mount(document.createElement("div"));
		host.setAttribute("role", role);
		for (const [k, v] of Object.entries(attrs)) host.setAttribute(k, v);
		const inner = document.createElement("button");
		host.appendChild(inner);
		return { host, inner };
	}

	it("stays quiet inside a dialog (was: M muted the player behind the Share dialog)", () => {
		usePlayerStore.setState({ currentTrack: track, isPlaying: true, volume: 50, queue: queue3, queueIndex: 0 });
		renderHook(() => useKeyboardShortcuts());
		const { inner } = layer("dialog");
		press("m", {}, inner);
		press("ArrowRight", {}, inner);
		expect(usePlayerStore.getState().volume).toBe(50);
		expect(usePlayerStore.getState().queueIndex).toBe(0);
	});

	it("stays quiet on an open menu's container (was: ArrowRight on a just-opened menu skipped the track)", () => {
		usePlayerStore.setState({ currentTrack: track, isPlaying: true, queue: queue3, queueIndex: 0 });
		renderHook(() => useKeyboardShortcuts());
		const { host } = layer("menu");
		expect(press("ArrowRight", {}, host).defaultPrevented).toBe(false);
		expect(usePlayerStore.getState().queueIndex).toBe(0);
	});

	it("doesn't open the palette over a dialog (was: '/' and Ctrl+K opened a palette the dialog's focus trap made unusable)", () => {
		renderHook(() => useKeyboardShortcuts());
		const { inner } = layer("alertdialog");
		press("/", {}, inner);
		expect(useCommandStore.getState().isOpen).toBe(false);
		press("k", { ctrlKey: true }, inner);
		expect(useCommandStore.getState().isOpen).toBe(false);
	});

	it("keeps the player shortcuts in Now Playing (data-hotkeys=player)", () => {
		usePlayerStore.setState({ currentTrack: track, isPlaying: true, volume: 50 });
		renderHook(() => useKeyboardShortcuts());
		const { inner } = layer("dialog", { "data-hotkeys": "player", "aria-modal": "true" });
		press("m", {}, inner);
		expect(usePlayerStore.getState().volume).toBe(0);
	});
});

describe("useKeyboardShortcuts — held keys (HK-04)", () => {
	it("ignores auto-repeat for track skips, play/pause, mute and Ctrl+K (was: holding → skipped through the queue)", () => {
		usePlayerStore.setState({ currentTrack: track, isPlaying: true, volume: 50, queue: queue3, queueIndex: 0 });
		renderHook(() => useKeyboardShortcuts());
		press("ArrowRight");
		press("ArrowRight", { repeat: true });
		press("ArrowRight", { repeat: true });
		expect(usePlayerStore.getState().queueIndex).toBe(1);
		press(" ", { repeat: true });
		expect(usePlayerStore.getState().isPlaying).toBe(true);
		press("m", { repeat: true });
		expect(usePlayerStore.getState().volume).toBe(50);
		press("k", { ctrlKey: true, repeat: true });
		expect(useCommandStore.getState().isOpen).toBe(false);
	});

	it("keeps auto-repeat for seeking and volume", () => {
		usePlayerStore.setState({ currentTrack: track, isPlaying: true, volume: 50, currentTime: 20, duration: 100 });
		renderHook(() => useKeyboardShortcuts());
		press("l", { repeat: true });
		press("ArrowRight", { shiftKey: true, repeat: true });
		expect(usePlayerStore.getState().currentTime).toBe(40);
		press("ArrowUp", { shiftKey: true, repeat: true });
		expect(usePlayerStore.getState().volume).toBe(55);
	});
});

describe("useKeyboardShortcuts — seeking (HK-09)", () => {
	it("seeks forward when the duration isn't known yet (was: L / Shift+→ jumped back to 0:00)", () => {
		usePlayerStore.setState({ currentTrack: track, isPlaying: true, currentTime: 30, duration: 0 });
		renderHook(() => useKeyboardShortcuts());
		press("l");
		expect(usePlayerStore.getState().currentTime).toBe(40);
		press("ArrowRight", { shiftKey: true });
		expect(usePlayerStore.getState().currentTime).toBe(50);
	});

	it("still stops at the end and at the start", () => {
		usePlayerStore.setState({ currentTrack: track, isPlaying: true, currentTime: 95, duration: 100 });
		renderHook(() => useKeyboardShortcuts());
		press("l");
		expect(usePlayerStore.getState().currentTime).toBe(100);
		usePlayerStore.setState({ currentTime: 4 });
		press("j");
		expect(usePlayerStore.getState().currentTime).toBe(0);
	});
});

describe("useKeyboardShortcuts — keyboard layouts and IME (HK-10)", () => {
	it("reads the physical key on non-Latin layouts (was: Ctrl+K and M did nothing on a Russian keyboard)", () => {
		usePlayerStore.setState({ currentTrack: track, isPlaying: true, volume: 50 });
		renderHook(() => useKeyboardShortcuts());
		press("ь", { code: "KeyM" });
		expect(usePlayerStore.getState().volume).toBe(0);
		press("л", { code: "KeyK", ctrlKey: true });
		expect(useCommandStore.getState().isOpen).toBe(true);
	});

	it("keeps the typed letter on AZERTY (the M key, not the physical ; key)", () => {
		usePlayerStore.setState({ currentTrack: track, isPlaying: true, volume: 50 });
		renderHook(() => useKeyboardShortcuts());
		press("m", { code: "Semicolon" });
		expect(usePlayerStore.getState().volume).toBe(0);
	});

	it("leaves keys to an IME composition", () => {
		usePlayerStore.setState({ currentTrack: track, isPlaying: true });
		renderHook(() => useKeyboardShortcuts());
		press(" ", { isComposing: true });
		expect(usePlayerStore.getState().isPlaying).toBe(true);
	});
});

describe("useKeyboardShortcuts — Escape closes the top-most player layer only (HK-03, HK-06)", () => {
	it("closes Now Playing (was: Escape did nothing in the fullscreen player)", () => {
		usePlayerStore.setState({ currentTrack: track, fullscreenOpen: true });
		renderHook(() => useKeyboardShortcuts());
		const e = press("Escape");
		expect(e.defaultPrevented).toBe(true);
		expect(usePlayerStore.getState().fullscreenOpen).toBe(false);
	});

	it("closes the immersive lyrics, then the queue, then Now Playing", () => {
		usePlayerStore.setState({ currentTrack: track, fullscreenOpen: true, queuePanelOpen: true });
		useLyricsStore.setState({ immersiveOpen: true });
		renderHook(() => useKeyboardShortcuts());
		press("Escape");
		expect(useLyricsStore.getState().immersiveOpen).toBe(false);
		expect(usePlayerStore.getState().queuePanelOpen).toBe(true);
		press("Escape");
		expect(usePlayerStore.getState().queuePanelOpen).toBe(false);
		expect(usePlayerStore.getState().fullscreenOpen).toBe(true);
		press("Escape");
		expect(usePlayerStore.getState().fullscreenOpen).toBe(false);
	});

	it("leaves the queue open when Escape closes the palette (was: one Escape closed both)", () => {
		usePlayerStore.setState({ currentTrack: track, queuePanelOpen: true });
		useCommandStore.setState({ isOpen: true });
		renderHook(() => useKeyboardShortcuts());
		press("Escape");
		expect(useCommandStore.getState().isOpen).toBe(false);
		expect(usePlayerStore.getState().queuePanelOpen).toBe(true);
	});

	it("leaves the queue open when a field or a dialog handled Escape (was: leaving the search field closed the queue)", () => {
		usePlayerStore.setState({ currentTrack: track, queuePanelOpen: true });
		renderHook(() => useKeyboardShortcuts());
		const handled = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
		handled.preventDefault();
		document.body.dispatchEvent(handled);
		const dialog = mount(document.createElement("div"));
		dialog.setAttribute("role", "dialog");
		press("Escape", {}, dialog);
		expect(usePlayerStore.getState().queuePanelOpen).toBe(true);
	});
});
