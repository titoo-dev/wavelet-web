import { create } from "zustand";
import { persist } from "zustand/middleware";
import { haptic } from "@/utils/haptic";
import { isRemote, muteToggleCommand, sendIfRemote } from "@/lib/playback-sync/remote";
import { MAX_QUEUE, toSessionTrack, windowStartFor } from "@/lib/playback-sync/track";
import type { Command } from "@/lib/playback-sync/types";
import { DEFAULT_SOUND, EQ_BANDS, eqGains, normalizeSound, type EqPresetId, type SoundSettings, type SpatialMode } from "@/components/audio/engine/sound";

export interface PlayerTrack {
	trackId: string;
	title: string;
	artist: string;
	artistId?: string | null;
	album?: string | null;
	albumId?: string | null;
	cover: string | null;
	duration: number | null;
	/** How the track got into the queue: "autoplay" for tracks added once the queue ran out. */
	source?: string | null;
}

type RepeatMode = "off" | "all" | "one";

/**
 * Fisher-Yates shuffle, returns a new array. Pure helper — does not mutate.
 */
function shuffleArray<T>(arr: T[]): T[] {
	const out = arr.slice();
	for (let i = out.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		[out[i], out[j]] = [out[j], out[i]];
	}
	return out;
}

interface PlayerState {
	currentTrack: PlayerTrack | null;
	queue: PlayerTrack[];
	queueIndex: number;
	isPlaying: boolean;
	isBuffering: boolean;
	volume: number;
	/** Last volume > 0, used by toggleMute to restore. */
	_lastNonZeroVolume: number;
	currentTime: number;
	duration: number;
	/** Last buffered end position (seconds) reported by the audio element. */
	buffered: number;
	shuffle: boolean;
	repeat: RepeatMode;
	/** Set by prev()/seek() to signal AudioEngine to seek; AudioEngine clears it after seeking. */
	_seekTo: number | null;
	/** Counter bumped by retryTrack() — AudioEngine watches it to force a reload. */
	_retryLoadCount: number;
	/** Playback error message, null when no error. */
	error: string | null;
	fullscreenOpen: boolean;
	/** Whether the "Up Next" queue panel is open. */
	queuePanelOpen: boolean;

	// P2 features
	crossfadeDuration: number;
	normalizationEnabled: boolean;
	/** Headphone spatialisation + equaliser of this device (engine/sound.ts); all off by default. */
	sound: SoundSettings;
	/** Sample-accurate transitions between cached MP3 tracks (MSE deck); off by default. Not with crossfade. */
	gapless: boolean;
	/** Similar tracks are added when the last track of the queue starts (useAutoplay); on by default. */
	autoplay: boolean;

	play: (track: PlayerTrack, queue?: PlayerTrack[]) => void;
	pause: () => void;
	resume: () => void;
	toggle: () => void;
	stop: () => void;
	next: () => void;
	prev: () => void;
	/** Like prev() but always goes to previous track (no restart-if->3s). Used by fullscreen swipe. */
	prevTrack: () => void;
	/** Seek to a specific time (seconds). Updates currentTime immediately and signals AudioEngine. */
	seek: (time: number) => void;
	/** Force a reload of the current track (after a playback failure). */
	retryTrack: () => void;
	setError: (error: string | null) => void;
	setVolume: (v: number) => void;
	/** Toggle mute: 0 → last non-zero volume, anything else → 0. */
	toggleMute: () => void;
	setCurrentTime: (t: number) => void;
	setDuration: (d: number) => void;
	setBuffered: (b: number) => void;
	setBuffering: (b: boolean) => void;
	toggleShuffle: () => void;
	toggleRepeat: () => void;
	setFullscreenOpen: (v: boolean) => void;
	setQueuePanelOpen: (v: boolean) => void;
	/** Jump directly to a queue index (used by Queue panel click-to-play). */
	jumpToIndex: (index: number) => void;
	playQueue: (queue: PlayerTrack[], startIndex?: number) => void;
	setCrossfadeDuration: (seconds: number) => void;
	toggleNormalization: () => void;
	setSpatial: (mode: SpatialMode) => void;
	setEqPreset: (preset: EqPresetId) => void;
	/** Move one band (dB); the curve becomes the custom one, starting from the preset in effect. */
	setEqBand: (band: number, db: number) => void;
	toggleGapless: () => void;
	toggleAutoplay: () => void;

	// Queue management (P2)
	/** Insert a track right after the current track ("Play Next"). */
	addNext: (track: PlayerTrack) => void;
	/**
	 * Append a track to the end of the queue ("Add to Queue"). Returns false
	 * when it is already up next; played tracks (and the current one) can be
	 * queued again.
	 */
	addToQueue: (track: PlayerTrack) => boolean;
	/** Remove a track from the queue by its queue index. */
	removeFromQueue: (index: number) => void;
	/** Move a track within the queue (drag-reorder). */
	moveInQueue: (from: number, to: number) => void;
	/** Clear the queue except the currently playing track. */
	clearQueue: () => void;
	/**
	 * Append autoplay tracks after `afterTrackId`, only while it is still the
	 * last track of the queue (the queue may have moved during the request).
	 * Returns how many were added.
	 */
	appendAutoplay: (tracks: PlayerTrack[], afterTrackId: string) => number;
}

/** Navigate to a queue index, setting it as the current track. */
function goToIndex(queueIndex: number, queue: PlayerTrack[]): Partial<PlayerState> {
	return {
		currentTrack: queue[queueIndex],
		queueIndex,
		isPlaying: true,
		isBuffering: true,
		currentTime: 0,
		buffered: 0,
		error: null,
	};
}

/**
 * Build a queue with `start` placed at index 0 and the rest shuffled.
 * Used when starting playback with shuffle ON — the tapped track plays first,
 * then everything else plays in randomised order.
 */
function shuffleAround(queue: PlayerTrack[], startIndex: number): PlayerTrack[] {
	if (queue.length <= 1) return queue.slice();
	const start = queue[startIndex];
	const rest = queue.filter((_, i) => i !== startIndex);
	return [start, ...shuffleArray(rest)];
}

/**
 * A Remote's "play this queue from there" as a Command. The Active Device applies its own
 * shuffle to it; a queue longer than a window is cut around the start track.
 */
function playQueueCommand(queue: PlayerTrack[], startIndex: number): Command {
	const from = windowStartFor(queue.length, startIndex);
	return {
		type: "playQueue",
		tracks: queue.slice(from, from + MAX_QUEUE).map(toSessionTrack),
		startIndex: startIndex - from,
	};
}

export const usePlayerStore = create<PlayerState>()(
	persist(
		(set, get) => ({
			currentTrack: null,
			queue: [],
			queueIndex: -1,
			isPlaying: false,
			isBuffering: false,
			volume: 80,
			_lastNonZeroVolume: 80,
			currentTime: 0,
			duration: 0,
			buffered: 0,
			shuffle: false,
			repeat: "off" as RepeatMode,
			_seekTo: null,
			_retryLoadCount: 0,
			error: null,
			fullscreenOpen: false,
			queuePanelOpen: false,
			crossfadeDuration: 0,
			normalizationEnabled: false,
			sound: DEFAULT_SOUND,
			gapless: false,
			autoplay: true,

			play: (track, queue) => {
				const state = get();
				const isSameTrack = state.currentTrack?.trackId === track.trackId;
				// A Remote plays on the Active Device (CONTEXT.md, Remote).
				if (
					sendIfRemote(() => {
						if (queue) {
							const idx = queue.findIndex((t) => t.trackId === track.trackId);
							return playQueueCommand(queue, idx >= 0 ? idx : 0);
						}
						return isSameTrack ? { type: "resume" } : playQueueCommand([track], 0);
					})
				) {
					return;
				}
				if (queue) {
					const idx = queue.findIndex((t) => t.trackId === track.trackId);
					const startIdx = idx >= 0 ? idx : 0;
					if (state.shuffle && queue.length > 1) {
						const shuffled = shuffleAround(queue, startIdx);
						set({
							currentTrack: shuffled[0],
							queue: shuffled,
							queueIndex: 0,
							isPlaying: true,
							isBuffering: true,
							currentTime: 0,
							error: null,
						});
					} else {
						set({
							currentTrack: track,
							queue,
							queueIndex: startIdx,
							isPlaying: true,
							isBuffering: true,
							currentTime: 0,
							error: null,
						});
					}
				} else if (isSameTrack) {
					set({ isPlaying: true, error: null });
				} else {
					set({
						currentTrack: track,
						queue: [track],
						queueIndex: 0,
						isPlaying: true,
						isBuffering: true,
						currentTime: 0,
						error: null,
					});
				}
			},

			// On a Remote, transport changes show at once and the Active Device's publish confirms them.
			pause: () => {
				sendIfRemote({ type: "pause" });
				set({ isPlaying: false });
			},
			resume: () => {
				sendIfRemote({ type: "resume" });
				set({ isPlaying: true });
			},
			toggle: () => {
				haptic(8);
				sendIfRemote(() => ({ type: get().isPlaying ? "pause" : "resume" }));
				set((s) => ({ isPlaying: !s.isPlaying }));
			},
			stop: () => set({
				currentTrack: null, queue: [], queueIndex: -1,
				isPlaying: false, isBuffering: false,
				currentTime: 0, duration: 0, buffered: 0, error: null,
				fullscreenOpen: false, queuePanelOpen: false,
			}),

			next: () => {
				if (sendIfRemote({ type: "next" })) return;
				const { queue, queueIndex, shuffle, repeat } = get();
				if (queue.length === 0) return;

				const nextQueueIndex = queueIndex + 1;
				if (nextQueueIndex >= queue.length) {
					if (repeat === "all") {
						if (shuffle && queue.length > 1) {
							// Re-shuffle for the next cycle. Place the just-finished
							// track at index 0 to avoid replaying it back-to-back.
							const reshuffled = shuffleAround(queue, queue.length - 1);
							// Now queueIndex moves to 1 (skip the just-played one at 0).
							// But if the user explicitly hit next we should advance: jump to index 1.
							set({ queue: reshuffled, ...goToIndex(1, reshuffled) });
							return;
						}
						set(goToIndex(0, queue));
						return;
					}
					// Queue exhausted — close the player.
					get().stop();
					return;
				}

				set(goToIndex(nextQueueIndex, queue));
			},

			prev: () => {
				if (sendIfRemote({ type: "prev" })) return;
				const { queue, queueIndex, currentTime, repeat } = get();
				if (queue.length === 0) return;

				// If more than 3 seconds in, restart current track
				if (currentTime > 3) {
					set({ currentTime: 0, _seekTo: 0 });
					return;
				}

				if (queueIndex === 0) {
					if (repeat === "all") {
						set(goToIndex(queue.length - 1, queue));
					} else {
						set({ currentTime: 0, _seekTo: 0 });
					}
					return;
				}

				set(goToIndex(queueIndex - 1, queue));
			},

			prevTrack: () => {
				const { queue, queueIndex, repeat } = get();
				if (queue.length === 0) return;
				if (sendIfRemote(queueIndex > 0 ? { type: "jumpTo", index: queueIndex - 1 } : { type: "prev" })) return;

				if (queueIndex === 0) {
					if (repeat === "all") {
						set(goToIndex(queue.length - 1, queue));
					} else {
						set({ currentTime: 0, _seekTo: 0 });
					}
					return;
				}

				set(goToIndex(queueIndex - 1, queue));
			},

			seek: (time) => {
				const { duration } = get();
				const clamped = Math.max(0, duration > 0 ? Math.min(time, duration) : time);
				// A Remote has nothing to seek: the Active Device does, and its position shows here.
				if (sendIfRemote({ type: "seek", positionMs: Math.round(clamped * 1000) })) {
					set({ currentTime: clamped });
					return;
				}
				set({ currentTime: clamped, _seekTo: clamped });
			},
			retryTrack: () => {
				// A Remote plays nothing, so it has nothing to reload.
				if (isRemote()) return;
				set((s) => ({
					_retryLoadCount: s._retryLoadCount + 1,
					error: null,
					isPlaying: true,
					isBuffering: true,
				}));
			},
			setError: (error) => set({ error }),
			setVolume: (volume) => {
				// A Remote sets the Active Device's volume; its own stays as it was.
				if (sendIfRemote({ type: "setVolume", volume: Math.max(0, Math.min(100, volume)) / 100 })) return;
				// Remember last non-zero volume so mute toggle can restore it
				if (volume > 0) {
					set({ volume, _lastNonZeroVolume: volume });
				} else {
					set({ volume });
				}
			},
			toggleMute: () => {
				haptic(6);
				if (sendIfRemote(muteToggleCommand)) return;
				const { volume, _lastNonZeroVolume } = get();
				if (volume > 0) {
					set({ volume: 0, _lastNonZeroVolume: volume });
				} else {
					set({ volume: _lastNonZeroVolume > 0 ? _lastNonZeroVolume : 80 });
				}
			},
			setCurrentTime: (currentTime) => set({ currentTime }),
			setDuration: (duration) => set({ duration }),
			setBuffered: (buffered) => set({ buffered }),
			setBuffering: (isBuffering) => set({ isBuffering }),

			toggleShuffle: () => {
				const { shuffle, queue, queueIndex } = get();
				// The Active Device shuffles (ADR 0003) and publishes the order it picked.
				if (sendIfRemote({ type: "setShuffle", on: !shuffle })) {
					set({ shuffle: !shuffle });
					return;
				}
				if (!shuffle) {
					// Turning ON: shuffle the upcoming tracks. Played tracks and the
					// current track keep their position so history stays coherent.
					if (queue.length <= 1 || queueIndex < 0) {
						set({ shuffle: true });
						return;
					}
					const before = queue.slice(0, queueIndex + 1);
					const after = queue.slice(queueIndex + 1);
					set({
						shuffle: true,
						queue: [...before, ...shuffleArray(after)],
					});
				} else {
					// Turning OFF: keep the current queue order — don't try to restore
					// the original order, which we no longer track.
					set({ shuffle: false });
				}
			},

			setFullscreenOpen: (fullscreenOpen) => set({ fullscreenOpen }),
			setQueuePanelOpen: (queuePanelOpen) => set({ queuePanelOpen }),

			jumpToIndex: (index) => {
				const { queue } = get();
				if (index < 0 || index >= queue.length) return;
				if (sendIfRemote({ type: "jumpTo", index })) return;
				set(goToIndex(index, queue));
			},

			setCrossfadeDuration: (crossfadeDuration) => set({ crossfadeDuration }),
			toggleNormalization: () => set((s) => ({ normalizationEnabled: !s.normalizationEnabled })),
			setSpatial: (spatial) => set((s) => ({ sound: { ...s.sound, spatial } })),
			setEqPreset: (eqPreset) => set((s) => ({ sound: { ...s.sound, eqPreset } })),
			setEqBand: (band, db) =>
				set((s) => {
					if (band < 0 || band >= EQ_BANDS.length) return {};
					const eqCustom = eqGains(s.sound);
					eqCustom[band] = db;
					return { sound: normalizeSound({ ...s.sound, eqPreset: "custom", eqCustom }) };
				}),
			toggleGapless: () => set((s) => ({ gapless: !s.gapless })),
			toggleAutoplay: () => set((s) => ({ autoplay: !s.autoplay })),
			toggleRepeat: () => {
				const current = get().repeat;
				const repeat: RepeatMode = current === "off" ? "all" : current === "all" ? "one" : "off";
				sendIfRemote({ type: "setRepeat", mode: repeat });
				set({ repeat });
			},

			playQueue: (queue, startIndex = 0) => {
				if (queue.length === 0) return;
				if (sendIfRemote(() => playQueueCommand(queue, startIndex))) return;
				const { shuffle } = get();
				if (shuffle && queue.length > 1) {
					const shuffled = shuffleAround(queue, startIndex);
					set({
						queue: shuffled,
						queueIndex: 0,
						currentTrack: shuffled[0],
						isPlaying: true,
						isBuffering: true,
						currentTime: 0,
					});
				} else {
					set({
						queue,
						queueIndex: startIndex,
						currentTrack: queue[startIndex],
						isPlaying: true,
						isBuffering: true,
						currentTime: 0,
					});
				}
			},

			// --- Queue Management (P2) ---

			addNext: (track) => {
				const { queue, queueIndex } = get();
				// If nothing is playing, just start playing this track
				if (queue.length === 0 || queueIndex < 0) {
					get().play(track);
					return;
				}
				// Avoid duplicates: remove existing occurrence first
				const existingIdx = queue.findIndex((t) => t.trackId === track.trackId);
				const newQueue = [...queue];
				let newQueueIndex = queueIndex;

				if (existingIdx >= 0 && existingIdx !== queueIndex) {
					newQueue.splice(existingIdx, 1);
					if (existingIdx < newQueueIndex) newQueueIndex--;
				}

				const insertAt = newQueueIndex + 1;
				newQueue.splice(insertAt, 0, track);

				// Queue edits on a Remote show at once; the Active Device's publish replaces them.
				sendIfRemote(() => ({ type: "addNext", track: toSessionTrack(track) }));
				set({ queue: newQueue, queueIndex: newQueueIndex });
			},

			addToQueue: (track) => {
				const { queue, queueIndex } = get();
				if (queue.length === 0 || queueIndex < 0) {
					get().play(track);
					return true;
				}
				if (queue.slice(queueIndex + 1).some((t) => t.trackId === track.trackId)) return false;
				sendIfRemote(() => ({ type: "addToQueue", tracks: [toSessionTrack(track)] }));
				set({ queue: [...queue, track] });
				return true;
			},

			removeFromQueue: (index) => {
				const { queue, queueIndex } = get();
				if (index < 0 || index >= queue.length) return;
				if (index === queueIndex) return;
				sendIfRemote({ type: "remove", index });

				const newQueue = [...queue];
				newQueue.splice(index, 1);

				let newQueueIndex = queueIndex;
				if (index < queueIndex) newQueueIndex--;

				set({
					queue: newQueue,
					queueIndex: newQueueIndex,
					currentTrack: newQueue[newQueueIndex],
				});
			},

			moveInQueue: (from, to) => {
				const { queue, queueIndex } = get();
				if (from === to || from < 0 || to < 0 || from >= queue.length || to >= queue.length) return;
				sendIfRemote({ type: "move", from, to });

				const newQueue = [...queue];
				const [moved] = newQueue.splice(from, 1);
				newQueue.splice(to, 0, moved);

				let newQueueIndex = queueIndex;
				if (from === queueIndex) {
					newQueueIndex = to;
				} else if (from < queueIndex && to >= queueIndex) {
					newQueueIndex--;
				} else if (from > queueIndex && to <= queueIndex) {
					newQueueIndex++;
				}

				set({
					queue: newQueue,
					queueIndex: newQueueIndex,
					currentTrack: newQueue[newQueueIndex],
				});
			},

			clearQueue: () => {
				const { currentTrack, queue } = get();
				if (!currentTrack || queue.length <= 1) return;
				sendIfRemote({ type: "clearUpcoming" });
				set({
					queue: [currentTrack],
					queueIndex: 0,
				});
			},

			appendAutoplay: (tracks, afterTrackId) => {
				const { queue, repeat } = get();
				if (isRemote() || repeat !== "off" || queue.at(-1)?.trackId !== afterTrackId) return 0;
				const queued = new Set(queue.map((t) => t.trackId));
				const added: PlayerTrack[] = [];
				for (const t of tracks) {
					if (queued.has(t.trackId)) continue;
					queued.add(t.trackId);
					added.push({ ...t, source: "autoplay" });
				}
				if (added.length > 0) set({ queue: [...queue, ...added] });
				return added.length;
			},
		}),
		{
			name: "wavelet-player",
			partialize: (state) => ({
				volume: state.volume,
				_lastNonZeroVolume: state._lastNonZeroVolume,
				shuffle: state.shuffle,
				repeat: state.repeat,
				// Persist playback context so the player bar is restored on refresh.
				// isPlaying is NOT persisted — audio never auto-starts on page load.
				queue: state.queue,
				queueIndex: state.queueIndex,
				currentTrack: state.currentTrack,
				crossfadeDuration: state.crossfadeDuration,
				normalizationEnabled: state.normalizationEnabled,
				sound: state.sound,
				gapless: state.gapless,
				autoplay: state.autoplay,
			}),
			// Stored sound settings are checked: an unknown mode or a short curve falls back to the defaults.
			merge: (persisted, current) => {
				const p = (persisted ?? {}) as Partial<PlayerState>;
				return { ...current, ...p, sound: normalizeSound(p.sound) };
			},
		}
	)
);
