"use client";

import { useEffect } from "react";
import { usePlayerStore } from "@/stores/usePlayerStore";
import { shownVolume } from "@/lib/playback-sync/useSyncStore";
import { useCommandStore } from "@/stores/useCommandStore";
import { useLyricsStore } from "@/stores/useLyricsStore";
import { insideForeignLayer, isActivatable, isComposing, letterOf, ownsKeys } from "@/lib/hotkeys";

/**
 * Global keyboard shortcuts.
 * - ⌘K / Ctrl+K: toggle the command palette (search + downloads)
 * - /: open the command palette
 * - Escape: close the top-most player layer (immersive lyrics, then the queue, then Now Playing)
 * Audio player:
 * - Space: play/pause
 * - ArrowRight: next track
 * - ArrowLeft: previous track
 * - Shift+ArrowRight / L: seek forward 10s
 * - Shift+ArrowLeft / J: seek backward 10s
 * - Shift+ArrowUp: volume up
 * - Shift+ArrowDown: volume down
 * - M: mute/unmute
 * With nothing loaded, Space and the arrows stay with the browser (page
 * scrolling); plain ArrowUp / ArrowDown always do. Keys go to whoever already
 * owns them: a handler that called preventDefault, a text field or widget, Space
 * on a button or link, an open dialog or menu (Now Playing and the immersive
 * lyrics opt back in with `data-hotkeys="player"`). Letters are read from the
 * physical key on non-Latin layouts. Held keys only repeat seeking and volume.
 */
export function useKeyboardShortcuts() {
	useEffect(() => {
		function handleKeyDown(e: KeyboardEvent) {
			if (isComposing(e)) return;
			const letter = letterOf(e);
			const palette = useCommandStore.getState();

			// ⌘K / Ctrl+K toggles the command palette from anywhere, even inputs —
			// but never opens it over a dialog whose focus trap would make it unusable.
			if ((e.metaKey || e.ctrlKey) && letter === "k") {
				if (!palette.isOpen && insideForeignLayer(e.target)) return;
				e.preventDefault();
				if (!e.repeat) palette.toggle();
				return;
			}
			// Palette owns the keyboard while it's open — Escape still closes it if the focus left it.
			if (palette.isOpen) {
				if (e.key === "Escape" && !e.defaultPrevented) palette.close();
				return;
			}
			// Already handled (a queue row's Space, a field's Escape…), or inside a dialog / menu.
			if (e.defaultPrevented || insideForeignLayer(e.target)) return;

			if (e.key === "Escape") {
				if (closeTopPlayerLayer()) e.preventDefault();
				return;
			}
			if (ownsKeys(e.target)) return;
			if (e.metaKey || e.ctrlKey || e.altKey) return;

			const state = usePlayerStore.getState();
			// Seeking and volume follow a held key; everything else acts once per press.
			const once = (act: () => void) => {
				e.preventDefault();
				if (!e.repeat) act();
			};

			if (e.key === "/") {
				once(() => useCommandStore.getState().open());
				return;
			}

			switch (e.key) {
				case " ": {
					// A focused button or link gets its own activation.
					if (!state.currentTrack || isActivatable(e.target)) return;
					once(state.toggle);
					return;
				}
				case "ArrowRight": {
					if (!state.currentTrack) return;
					if (e.shiftKey) {
						e.preventDefault();
						state.seek(state.currentTime + 10);
					} else {
						once(state.next);
					}
					return;
				}
				case "ArrowLeft": {
					if (!state.currentTrack) return;
					if (e.shiftKey) {
						e.preventDefault();
						state.seek(state.currentTime - 10);
					} else {
						once(state.prev);
					}
					return;
				}
				case "ArrowUp": {
					// Plain ArrowUp / ArrowDown scroll the page.
					if (!e.shiftKey) return;
					e.preventDefault();
					state.setVolume(Math.min(100, shownVolume() + 5));
					return;
				}
				case "ArrowDown": {
					if (!e.shiftKey) return;
					e.preventDefault();
					state.setVolume(Math.max(0, shownVolume() - 5));
					return;
				}
			}

			switch (letter) {
				// The store clamps the target (and knows when the duration isn't known yet).
				case "l": {
					if (state.currentTrack) state.seek(state.currentTime + 10);
					return;
				}
				case "j": {
					if (state.currentTrack) state.seek(state.currentTime - 10);
					return;
				}
				case "m": {
					if (!e.repeat) state.toggleMute();
					return;
				}
			}
		}

		window.addEventListener("keydown", handleKeyDown);
		return () => window.removeEventListener("keydown", handleKeyDown);
	}, []);
}

/** Closes the top-most open player layer (z-order: lyrics 71 › queue 60 › Now Playing 58). */
function closeTopPlayerLayer(): boolean {
	const lyrics = useLyricsStore.getState();
	if (lyrics.immersiveOpen) {
		lyrics.setImmersiveOpen(false);
		return true;
	}
	const player = usePlayerStore.getState();
	if (player.queuePanelOpen) {
		player.setQueuePanelOpen(false);
		return true;
	}
	if (player.fullscreenOpen) {
		player.setFullscreenOpen(false);
		return true;
	}
	return false;
}
