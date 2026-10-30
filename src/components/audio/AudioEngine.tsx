"use client";

import { useEffect, useLayoutEffect, useRef, useCallback, useState } from "react";
import { currentLoginHref } from "@/lib/login-redirect";
import { usePlayerStore, type PlayerTrack } from "@/stores/usePlayerStore";
import { usePreviewStore } from "@/stores/usePreviewStore";
import { useSyncStore } from "@/lib/playback-sync/useSyncStore";
import { adjustVolume } from "@/utils/adjust-volume";
import {
	initAudioCtx,
	installGestureUnlock,
	isAudioCtxRunning,
	isRouted,
	readLevel,
	resetNormGain,
	routeElement,
	setElementVolume,
	setNormGain,
	setSoundEffects,
} from "@/utils/audio-context";
import { createLoudnessMeter, type LoudnessMeter } from "@/components/audio/engine/loudness";
import { startHandoff } from "@/components/audio/engine/handoff";
import { mediaMetadataInit } from "@/components/audio/engine/media-session";
import { getCachedBlobUrl, removeCached, setCacheLimit } from "@/lib/audio-cache";
import { toast } from "sonner";
import { useRouter } from "next/navigation";
import { useAuthStore } from "@/stores/useAuthStore";
import { diagnoseStreamFailure, type StreamFailureKind } from "@/lib/stream-failure";
import { canSeekInPlace, inRanges, isRangelessSource, planResume, seekLanded, waitForSeekableUrl } from "@/lib/seek";
import { formatTime } from "@/utils/format-time";
import {
	accumulateListened,
	advanceQueue,
	claimBackgroundPersist,
	createTrackSession,
	endReasonOf,
	reachedPlayThreshold,
	shouldNotifySkip,
	startVolume,
	takeListen,
	type TrackSession,
} from "@/components/audio/engine/session";
import type { ListenEndReason } from "@/lib/listens";
import {
	createAutoSkip,
	createTimerBag,
	sameTarget,
	type PlaybackTarget,
	type SkipReason,
} from "@/components/audio/engine/timers";
import {
	presignedUrls,
	progressiveUrl,
	proxyUrl,
	resolveCachedSource,
} from "@/components/audio/engine/presigned-urls";
import {
	cacheListenedTrack,
	createAudioElement,
	discardElement,
	disposePrefetchPools,
	persistInBackground,
	preloadTrack,
	queuePreloaded,
	smartPrefetchQueue,
	takePreloaded,
} from "@/components/audio/engine/prefetch";
import { classifySource, needsResign, planRecovery, resolvePlaybackUrl } from "@/components/audio/engine/source";
import { forgetSignedInState, watchSignOut } from "@/components/audio/engine/sign-out";
import { openGaplessDeck, supportsGaplessDeck, type GaplessDeck } from "@/components/audio/engine/gapless-deck";
import { gaplessNextDue, isDeckSource, nextInRun, wantsGapless } from "@/components/audio/engine/gapless-policy";

// Restore cache limit from localStorage
if (typeof window !== "undefined") {
	try {
		const saved = localStorage.getItem("wavelet-cache-limit");
		if (saved) {
			const bytes = parseInt(saved, 10);
			if (!isNaN(bytes) && bytes > 0) setCacheLimit(bytes);
		}
	} catch {}
}

// Presigned URLs come from one app-wide cache (engine/presigned-urls): reused
// until shortly before each URL's own expiresAt, refused per track after a
// failure — never a session-wide kill switch.

/**
 * Resolve audio URL for a track. Priority:
 * 1. IndexedDB blob URL (instant, zero network)
 * 2. Presigned R2 URL (direct browser streaming for cached tracks)
 * 3. Progressive endpoint (live decrypts from Deezer; redirects to /stream once cached)
 */
function getTrackUrl(trackId: string, opts: { skipBlob?: boolean } = {}): Promise<string> {
	return resolvePlaybackUrl(trackId, {
		urls: presignedUrls,
		blobUrl: getCachedBlobUrl,
		pageProtocol: window.location.protocol,
		skipBlob: opts.skipBlob,
	});
}

// Prefetch pools, warm levels and background fills live in engine/prefetch;
// warmTrack / preloadTrack stay importable from here.
export { warmTrack, preloadTrack, type WarmOptions } from "@/components/audio/engine/prefetch";

/**
 * Log a "real" play (≥30s of continuous playback) so the track joins the
 * user's recently-played history. Cap-aware on the server side.
 */
async function logRecentPlay(track: {
	trackId: string;
	title: string;
	artist: string;
	album?: string | null;
	albumId?: string | null;
	cover: string | null;
	duration: number | null;
}) {
	try {
		await fetch("/api/v1/recent-plays", {
			method: "POST",
			credentials: "include",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				trackId: track.trackId,
				title: track.title,
				artist: track.artist,
				album: track.album ?? null,
				albumId: track.albumId ?? null,
				coverUrl: track.cover,
				duration: track.duration,
			}),
		});
	} catch {
		// Non-fatal — just a missed history entry
	}
}

/**
 * Notify the server that the user skipped a track before reaching the 30s
 * threshold so its Blob file can be evicted (if no other user listened to it).
 * The DownloadHistory metadata stays for re-streaming on a future replay.
 */
function notifyTrackSkipped(trackId: string) {
	try {
		// sendBeacon survives page unload (closing tab during a play <30s)
		const url = `/api/v1/recent-plays/${trackId}/skip`;
		if (typeof navigator !== "undefined" && "sendBeacon" in navigator) {
			navigator.sendBeacon(url);
			return;
		}
		fetch(url, { method: "POST", credentials: "include", keepalive: true }).catch(() => {});
	} catch {
		// Non-fatal
	}
}

/**
 * Append the part of a play not reported yet to the listening log
 * (recommendation signals). keepalive: a closing tab still sends it.
 */
function reportListen(session: TrackSession | null, reason: ListenEndReason) {
	const listen = takeListen(session, reason, { client: "web", shuffle: usePlayerStore.getState().shuffle });
	if (!listen) return;
	try {
		fetch("/api/v1/listens", {
			method: "POST",
			credentials: "include",
			keepalive: true,
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ events: [listen] }),
		}).catch(() => {});
	} catch {
		// Non-fatal — a missed listen
	}
}

/**
 * Drives full-track playback from Blob using imperatively managed Audio objects.
 * Pre-buffers adjacent tracks in the queue for instant playback.
 * Also manages the Media Session API for OS-level media controls.
 */
const RESUME_KEY = "wavelet-resume";
// How long before the end of a track an uncached next track may start
// buffering through the live preview stream.
const LIVE_PRELOAD_LEAD_S = 30;
const RESUME_TTL_MS = 24 * 60 * 60 * 1000;

export function AudioEngine() {
	const audioRef = useRef<HTMLAudioElement | null>(null);
	const prevTrackIdRef = useRef<string | null>(null);
	// Flag to skip play/pause effect when loadTrack already handled playback
	const skipPlayEffectRef = useRef(false);
	// Generation counter to cancel stale track loads on rapid switching
	const loadGenRef = useRef(0);
	// Position to seek to after the first track-load completes (refresh/HMR
	// session restore). Cleared after use or on a different track-change.
	const resumePositionRef = useRef<number | null>(null);

	// A Remote outputs no sound (CONTEXT.md, Remote): the engine sees no track while another
	// Device plays, so it unloads, and loads the session's track again once this tab is active.
	const remote = useSyncStore((s) => s.role === "remote");
	const remoteRef = useRef(remote);
	const storeTrack = usePlayerStore((s) => s.currentTrack);
	const storeIsPlaying = usePlayerStore((s) => s.isPlaying);
	const currentTrack = remote ? null : storeTrack;
	const isPlaying = remote ? false : storeIsPlaying;
	const volume = usePlayerStore((s) => s.volume);
	const repeat = usePlayerStore((s) => s.repeat);
	const setCurrentTime = usePlayerStore((s) => s.setCurrentTime);
	const setDuration = usePlayerStore((s) => s.setDuration);
	const next = usePlayerStore((s) => s.next);
	const prev = usePlayerStore((s) => s.prev);
	const router = useRouter();
	const pause = usePlayerStore((s) => s.pause);
	const resume = usePlayerStore((s) => s.resume);

	const setBuffering = usePlayerStore((s) => s.setBuffering);
	const setBuffered = usePlayerStore((s) => s.setBuffered);
	const setError = usePlayerStore((s) => s.setError);
	const crossfadeDuration = usePlayerStore((s) => s.crossfadeDuration);
	const normalizationEnabled = usePlayerStore((s) => s.normalizationEnabled);

	const previewTrack = usePreviewStore((s) => s.currentTrack);
	const previewIsPlaying = usePreviewStore((s) => s.isPlaying);

	// Per-track state (play logging, retries, auto-advance…) — replaced as a
	// whole by beginTrack() whenever a track becomes current.
	const sessionRef = useRef<TrackSession | null>(null);
	const MAX_RETRIES = 2;
	// Consecutive track failures across the queue. If too many tracks fail
	// back-to-back, stop auto-skipping and show a clearer error so we don't
	// silently burn through the whole queue.
	const consecutiveFailuresRef = useRef(0);
	const MAX_CONSECUTIVE_FAILURES = 3;
	// Set right before the queue advances on its own (ended, auto-skip): the
	// next track starts without a fade-in.
	const autoAdvanceRef = useRef(false);

	// Retry / auto-skip timers of the current track: cleared on every track
	// change and reload, and re-checked against the current target on fire.
	const [timers] = useState(createTimerBag);
	const [autoSkip] = useState(() =>
		createAutoSkip({
			timers,
			currentTrackId: () => usePlayerStore.getState().currentTrack?.trackId ?? null,
		})
	);
	const currentTarget = useCallback(
		(): PlaybackTarget => ({
			gen: loadGenRef.current,
			element: audioRef.current,
			trackId: sessionRef.current?.trackId ?? null,
		}),
		[]
	);

	// Crossfade state
	const crossfadeActiveRef = useRef(false);
	const outgoingAudioRef = useRef<HTMLAudioElement | null>(null);

	// Normalisation of the current track: its level averaged over several
	// seconds, then one gain, applied to the element(s) playing that track.
	// Replaced on every track change (was: a 256-sample snapshot at 3 s, and
	// a shared gain node that carried the previous track's gain over).
	const normRef = useRef<{ meter: LoudnessMeter; gain: number | null; appliedTo: HTMLAudioElement | null }>({
		meter: createLoudnessMeter(),
		gain: null,
		appliedTo: null,
	});
	// Head → full handoff in flight (cancelled when the track changes).
	const cancelHandoffRef = useRef<(() => void) | null>(null);

	// Gapless run: the MSE deck that plays the current track and lines up the
	// next one sample-accurately (engine/gapless-deck); null on the plain
	// path. A deck failure keeps the rest of the run on the plain path — the
	// next track the user starts may try again.
	const deckRef = useRef<GaplessDeck | null>(null);
	const gaplessBlockedRef = useRef(false);
	// Next tracks the deck refused during this run, and the one being resolved.
	const deckDeclinedRef = useRef(new Set<string>());
	const deckResolvingRef = useRef<string | null>(null);

	// --- Stable event handler delegation via refs ---
	const handlersRef = useRef({
		onCanPlay: () => {},
		onTimeUpdate: () => {},
		onEnded: () => {},
		onError: () => {},
		onLoadedMetadata: () => {},
		onWaiting: () => {},
		onPlaying: () => {},
		onProgress: () => {},
	});

	const attachEvents = useCallback((audio: HTMLAudioElement) => {
		audio.oncanplay = () => handlersRef.current.onCanPlay();
		audio.ontimeupdate = () => handlersRef.current.onTimeUpdate();
		audio.onended = () => handlersRef.current.onEnded();
		audio.onerror = () => handlersRef.current.onError();
		audio.onloadedmetadata = () => handlersRef.current.onLoadedMetadata();
		audio.onwaiting = () => handlersRef.current.onWaiting();
		audio.onplaying = () => handlersRef.current.onPlaying();
		audio.onprogress = () => handlersRef.current.onProgress();
	}, []);

	const detachEvents = useCallback((audio: HTMLAudioElement) => {
		audio.oncanplay = null;
		audio.ontimeupdate = null;
		audio.onended = null;
		audio.onerror = null;
		audio.onloadedmetadata = null;
		audio.onwaiting = null;
		audio.onplaying = null;
		audio.onprogress = null;
	}, []);

	// Element-level activation. Every element that becomes the playing one —
	// fresh load, preload hit, crossfade, head→full handoff, retry, source
	// swap — goes through here.
	const activateElement = useCallback(
		(audio: HTMLAudioElement, track: { duration: number | null } | null = null) => {
			audioRef.current = audio;
			attachEvents(audio);
			// A prefetched element fired loadedmetadata before we listened:
			// report its duration now (was: a crossfaded track kept the
			// previous track's duration).
			if (audio.readyState >= 1 && isFinite(audio.duration) && audio.duration > 0) {
				setDuration(audio.duration);
			} else if (track) {
				setDuration(track.duration ?? 0);
			}
		},
		[attachEvents, setDuration]
	);

	// First play() of an element: a user-initiated start fades in, a queue
	// advance starts at full volume.
	const startPlayback = useCallback((audio: HTMLAudioElement) => {
		const session = sessionRef.current;
		const target = usePlayerStore.getState().volume / 100;
		const { from, fadeMs } = startVolume(!!session?.autoAdvance, target);
		if (session) session.autoAdvance = false;
		// A routed element is silent while the context is suspended.
		if (isRouted(audio) && !isAudioCtxRunning()) initAudioCtx();
		setElementVolume(audio, from);
		audio.play().then(
			() => toast.dismiss("play-blocked"),
			(err: unknown) => {
				// The autoplay policy refused: a tab that never had a click (a Transfer here, a
				// restored session). Paused rather than shown playing in silence, and the prompt's
				// button is the click the browser wants (was: playing everywhere, no sound).
				if ((err as { name?: string } | null)?.name !== "NotAllowedError" || audioRef.current !== audio) return;
				if (!usePlayerStore.getState().isPlaying) return;
				usePlayerStore.getState().pause();
				toast("Click to play here", {
					id: "play-blocked",
					description: "Your browser needs a click in this window before it plays sound.",
					duration: Infinity,
					action: { label: "Play", onClick: () => usePlayerStore.getState().resume() },
				});
			}
		);
		// duration 0 still cancels a fade-out left running on this element
		adjustVolume(audio, target, { duration: fadeMs });
	}, []);

	const pendingSeekRef = useRef<{ target: number } | null>(null);
	// An in-place seek on the live stream is checked on the next timeupdate:
	// a browser that snapped back to the start falls back to the stored file.
	const seekCheckRef = useRef<{ target: number; element: HTMLAudioElement } | null>(null);
	// The persisted file never showed up: the next resume plays on whatever
	// the live stream allows instead of waiting again.
	const lastResortSeekRef = useRef(false);

	// Track-level activation: ends the previous track's session (skip
	// notification) and starts a fresh one. Both paths that change the
	// current track — the load effect and the crossfade — go through here.
	const beginTrack = useCallback(
		(track: PlayerTrack) => {
			const { trackId } = track;
			const prev = sessionRef.current;
			if (prev && prev.trackId !== trackId && shouldNotifySkip(prev)) {
				notifyTrackSkipped(prev.trackId);
			}
			if (prev) reportListen(prev, endReasonOf(prev));
			sessionRef.current = createTrackSession(trackId, {
				autoAdvance: autoAdvanceRef.current,
				meta: { artistId: track.artistId, albumId: track.albumId, duration: track.duration, source: track.source },
			});
			autoAdvanceRef.current = false;
			prevTrackIdRef.current = trackId;
			// Timers of the previous track must never fire on this one.
			timers.clear();
			autoSkip.cancel();
			pendingSeekRef.current = null;
			seekCheckRef.current = null;
			lastResortSeekRef.current = false;
			normRef.current = { meter: createLoudnessMeter(), gain: null, appliedTo: null };
			cancelHandoffRef.current?.();
			cancelHandoffRef.current = null;
			setError(null);
		},
		[timers, autoSkip, setError]
	);

	// Hand off from a head-prefetched audio element (~3s buffered) to the
	// full progressive stream so playback continues seamlessly past the head.
	// We open the full stream right after the swap and ride out the head
	// segment; once the head approaches its end we copy state, swap refs,
	// and seek the full element to the head's position.
	// The head is server-capped (?head=1); only its cleanup is ours: the
	// handoff is cancelled by any track change, reload or stop (W8).
	const handoffFullStream = useCallback(
		(headAudio: HTMLAudioElement, trackId: string, gen: number) => {
			const fullAudio = createAudioElement();
			fullAudio.src = progressiveUrl(trackId);
			fullAudio.load();

			cancelHandoffRef.current?.();
			cancelHandoffRef.current = startHandoff({
				head: headAudio,
				full: fullAudio,
				stillCurrent: () => loadGenRef.current === gen && audioRef.current === headAudio,
				discard: discardElement,
				swap: (full, { position, wasPlaying }) => {
					cancelHandoffRef.current = null;
					detachEvents(headAudio);
					discardElement(headAudio);
					activateElement(full);
					try {
						full.currentTime = position;
					} catch {
						// Seek may throw if not enough buffered; the audio element
						// will handle it by re-buffering and seeking when ready.
					}
					setElementVolume(full, usePlayerStore.getState().volume / 100);
					if (wasPlaying || usePlayerStore.getState().isPlaying) {
						full.play().catch(() => {});
					}
				},
			});
		},
		[activateElement, detachEvents]
	);

	// Element-level teardown shared by every path that drops the current
	// element: events first (emptying src fires an error on some browsers),
	// then network and Web Audio nodes.
	const dropElement = useCallback(
		(audio: HTMLAudioElement) => {
			detachEvents(audio);
			discardElement(audio);
		},
		[detachEvents]
	);

	/** The deck, when `audio` is its element. */
	const deckOf = useCallback(
		(audio: HTMLAudioElement | null) => (audio && deckRef.current?.element === audio ? deckRef.current : null),
		[]
	);
	/** Track-relative position and length of what `audio` plays (the deck maps its run's timeline). */
	const timeOf = useCallback((audio: HTMLAudioElement) => deckOf(audio)?.trackTime() ?? audio.currentTime, [deckOf]);
	const durationOf = useCallback(
		(audio: HTMLAudioElement) => deckOf(audio)?.trackDuration() ?? audio.duration,
		[deckOf]
	);

	/** End the gapless run: the deck and its element go. */
	const leaveDeck = useCallback(() => {
		const deck = deckRef.current;
		if (!deck) return;
		deckRef.current = null;
		deckResolvingRef.current = null;
		deck.destroy();
		dropElement(deck.element);
	}, [dropElement]);

	const gaplessWanted = useCallback(
		() => wantsGapless(usePlayerStore.getState(), { supported: supportsGaplessDeck(), blocked: gaplessBlockedRef.current }),
		[]
	);

	// --- Restore playback position from previous session ---
	// Two paths:
	//  1. HMR / fast-refresh: the Zustand store is module-level and survives
	//     module reloads, so currentTime stays >0 if it was set.
	//  2. Full page refresh / tab close+reopen: the store rehydrates from
	//     localStorage but currentTime is not in `partialize`, so we use a
	//     dedicated localStorage entry written on pagehide.
	useEffect(() => {
		if (typeof window === "undefined") return;

		const track = usePlayerStore.getState().currentTrack;
		if (!track) return;

		const storeTime = usePlayerStore.getState().currentTime;
		if (storeTime > 1) {
			resumePositionRef.current = storeTime;
			return;
		}

		try {
			const raw = localStorage.getItem(RESUME_KEY);
			if (!raw) return;
			localStorage.removeItem(RESUME_KEY);
			const data = JSON.parse(raw) as { trackId?: string; time?: number; ts?: number };
			if (
				data?.trackId === track.trackId &&
				typeof data.time === "number" &&
				data.time > 1 &&
				Date.now() - (data.ts ?? 0) < RESUME_TTL_MS
			) {
				resumePositionRef.current = data.time;
				// Reflect in the store so SeekBar shows the right position before
				// the audio element actually loads + seeks.
				usePlayerStore.getState().setCurrentTime(data.time);
			}
		} catch {
			// Corrupt entry — ignore
		}
	}, []);

	// Remote → active (a Transfer here): start the session's track where the session is. Runs
	// before the load effect below, which picks resumePositionRef up.
	useLayoutEffect(() => {
		const was = remoteRef.current;
		remoteRef.current = remote;
		if (!was || remote) return;
		const time = usePlayerStore.getState().currentTime;
		resumePositionRef.current = isFinite(time) && time >= 1 ? time : null;
	}, [remote]);

	// Save current position on pagehide / tab hide so we can resume on refresh.
	// pagehide fires reliably on close + bfcache; visibilitychange catches
	// mobile background → kill scenarios where pagehide may not run.
	useEffect(() => {
		if (typeof window === "undefined") return;
		const save = () => {
			const audio = audioRef.current;
			const track = usePlayerStore.getState().currentTrack;
			if (!audio || !track) return;
			const time = timeOf(audio);
			if (!isFinite(time) || time < 1) return;
			try {
				localStorage.setItem(
					RESUME_KEY,
					JSON.stringify({ trackId: track.trackId, time, ts: Date.now() })
				);
			} catch {
				// Quota or disabled storage — non-fatal
			}
		};
		const onVisibility = () => {
			if (document.visibilityState === "hidden") save();
		};
		// The page goes away mid-track: report what was played so far (a page
		// back from the bfcache reports the rest as another part). Not on
		// visibilitychange: a hidden tab keeps playing.
		const onPageHide = () => {
			save();
			const session = sessionRef.current;
			if (session) reportListen(session, session.ended ? "completed" : "closed");
		};
		window.addEventListener("pagehide", onPageHide);
		document.addEventListener("visibilitychange", onVisibility);
		return () => {
			window.removeEventListener("pagehide", onPageHide);
			document.removeEventListener("visibilitychange", onVisibility);
		};
	}, [timeOf]);

	// --- Seeking on the live (range-less) stream ---
	// /stream-progressive is served without byte ranges: setting currentTime
	// past what the browser holds makes it restart the track from 0. Instead,
	// hang up the live stream (the server then drains Deezer at full speed into
	// Blob), wait for the persisted file and reopen it — Blob URLs support
	// Range — at the requested position. While a seek is pending, further
	// seeks only move its target (pendingSeekRef).
	const swapSource = useCallback(
		(url: string, position: number | null) => {
			const old = audioRef.current;
			++loadGenRef.current;
			timers.clear();
			cancelHandoffRef.current?.();
			cancelHandoffRef.current = null;
			if (old) dropElement(old);
			resumePositionRef.current = position;
			const audio = createAudioElement();
			activateElement(audio);
			audio.src = url;
			audio.load();
		},
		[activateElement, dropElement, timers]
	);

	// Point the current element at another URL of the same track and resume
	// where it was (error recovery). Dropped if the engine moved on while the
	// URL was being resolved.
	const reloadFrom = useCallback(
		(audio: HTMLAudioElement, url: Promise<string>, position: number) => {
			const scheduled = currentTarget();
			setBuffering(true);
			void url.then((next) => {
				if (!sameTarget(scheduled, currentTarget())) return;
				pendingSeekRef.current = null;
				resumePositionRef.current = isFinite(position) && position >= 1 ? position : null;
				audio.src = next;
				audio.load();
			});
		},
		[currentTarget, setBuffering]
	);

	const seekViaPersistedFile = useCallback(
		(audio: HTMLAudioElement, trackId: string, target: number) => {
			setCurrentTime(target);
			if (pendingSeekRef.current) {
				pendingSeekRef.current.target = target;
				return;
			}
			const pending = { target };
			pendingSeekRef.current = pending;
			const gen = loadGenRef.current;
			setBuffering(true);

			if (claimBackgroundPersist(sessionRef.current, audio.src)) persistInBackground(trackId);
			// Hang up so the server persists at network speed, not playback pace.
			// Events go first: emptying src fires an error on some browsers.
			detachEvents(audio);
			audio.pause();
			audio.src = "";

			const cancelled = () => pendingSeekRef.current !== pending || loadGenRef.current !== gen;
			void waitForSeekableUrl({
				// The presigned URL, or the range-capable proxy as soon as the
				// file is stored when presigned URLs are off or refused for this
				// track (was: waited the full minute, then restarted at 0).
				resolve: () => resolveCachedSource(trackId).then((source) => source?.url ?? null),
				isCancelled: cancelled,
				intervalMs: 1000,
				maxIntervalMs: 4000,
			}).then((url) => {
				if (cancelled()) return;
				pendingSeekRef.current = null;
				if (url) {
					swapSource(url, pending.target);
				} else {
					// Not stored in time: reopen the live stream at the target (it
					// seeks there when served with ranges, C2); otherwise it plays
					// from the start and says so (applyResumePosition).
					lastResortSeekRef.current = true;
					swapSource(progressiveUrl(trackId), pending.target);
				}
			});
		},
		[detachEvents, setBuffering, setCurrentTime, swapSource]
	);

	const seekInPlace = useCallback((audio: HTMLAudioElement, target: number) => {
		audio.currentTime = target;
		const buffered = inRanges(target, audio.buffered);
		seekCheckRef.current = isRangelessSource(audio.src) && !buffered ? { target, element: audio } : null;
	}, []);

	const applyResumePosition = useCallback(
		(audio: HTMLAudioElement) => {
			const resume = resumePositionRef.current;
			if (resume === null) return;
			resumePositionRef.current = null;
			const lastResort = lastResortSeekRef.current;
			lastResortSeekRef.current = false;
			const deck = deckOf(audio);
			if (deck) {
				// The whole file is in memory: the deck seeks anywhere in it.
				deck.seek(resume);
				setCurrentTime(resume);
				return;
			}
			const track = usePlayerStore.getState().currentTrack;
			const plan = planResume({
				resume,
				src: audio.src,
				duration: audio.duration,
				seekable: audio.seekable,
				buffered: audio.buffered,
				lastResort,
			});
			if (plan === "skip") return;
			if (track && plan === "via-file") {
				seekViaPersistedFile(audio, track.trackId, resume);
				return;
			}
			if (track && plan === "from-start") {
				// The file wasn't stored within the wait and this stream can't
				// seek: play from the start, but say so (was: silently at 0).
				setCurrentTime(0);
				toast(`Couldn't jump to ${formatTime(resume)} yet`, {
					id: "seek-fallback",
					description: "The track is still loading, so it plays from the start.",
				});
				return;
			}
			try {
				seekInPlace(audio, resume);
				setCurrentTime(resume);
			} catch {
				// Buffer might not cover seek target yet — browser will catch up
			}
		},
		[deckOf, setCurrentTime, seekViaPersistedFile, seekInPlace]
	);

	// The deck can't go on (fetch, append, quota, decode error): play the
	// track on the plain path from where it was, and keep the rest of the run
	// there.
	const leaveDeckForPlain = useCallback(
		(deck: GaplessDeck) => {
			if (deckRef.current !== deck) return;
			const track = usePlayerStore.getState().currentTrack;
			const position = deck.trackTime();
			gaplessBlockedRef.current = true;
			const gen = ++loadGenRef.current;
			timers.clear();
			leaveDeck();
			if (!track) return;
			pendingSeekRef.current = null;
			resumePositionRef.current = isFinite(position) && position >= 1 ? position : null;
			setBuffering(true);
			const audio = createAudioElement();
			activateElement(audio, track);
			void getTrackUrl(track.trackId).then((url) => {
				if (loadGenRef.current !== gen) return;
				audio.src = url;
				audio.load();
			});
		},
		[activateElement, leaveDeck, setBuffering, timers]
	);

	// Start a track on the gapless deck when it and the queue's next track both
	// have a cached copy and its file carries a LAME tag; otherwise on the
	// plain path — on `fallback` (a cached queue preload) when there is one.
	const startTrack = useCallback(
		(track: PlayerTrack, gen: number, fallback: HTMLAudioElement | null) => {
			// Holds the place (seek / pause land on it) until the path is known.
			const holder = createAudioElement();
			activateElement(holder, track);
			const stale = () => loadGenRef.current !== gen;
			void (async () => {
				const nextId = nextInRun(usePlayerStore.getState(), new Set());
				const [url, nextUrl] = await Promise.all([
					fallback ? Promise.resolve(fallback.src) : getTrackUrl(track.trackId),
					nextId ? getTrackUrl(nextId).catch(() => null) : Promise.resolve(null),
				]);
				const origin = window.location.origin;
				let deck: GaplessDeck | null = null;
				if (!stale() && isDeckSource(url, origin) && isDeckSource(nextUrl, origin)) {
					const opened = await openGaplessDeck(
						{ trackId: track.trackId, url },
						{
							createElement: createAudioElement,
							onFailure: () => {
								if (deck) leaveDeckForPlain(deck);
							},
							onNextDeclined: (id) => deckDeclinedRef.current.add(id),
						}
					);
					if (opened.ok) deck = opened.deck;
				}
				if (stale()) {
					if (deck) {
						deck.destroy();
						discardElement(deck.element);
					}
					if (fallback) discardElement(fallback);
					return;
				}
				if (deck) {
					if (fallback) discardElement(fallback);
					dropElement(holder);
					deckDeclinedRef.current = new Set();
					deckResolvingRef.current = null;
					deckRef.current = deck;
					activateElement(deck.element, track);
					return;
				}
				if (fallback) {
					dropElement(holder);
					activateElement(fallback, track);
					if (fallback.readyState >= 2) {
						setBuffering(false);
						applyResumePosition(fallback);
						if (usePlayerStore.getState().isPlaying) startPlayback(fallback);
					}
					return;
				}
				holder.src = url;
				holder.load();
			})();
		},
		[activateElement, applyResumePosition, dropElement, leaveDeckForPlain, setBuffering, startPlayback]
	);

	// --- Initialize audio element (client-only) ---
	useEffect(() => {
		if (!audioRef.current) {
			const audio = createAudioElement();
			audioRef.current = audio;
			attachEvents(audio);
		}
		// The AudioContext is created / resumed inside the click, tap or key
		// press that plays something (iOS ignores it anywhere else).
		const removeUnlock = installGestureUnlock(() => !!usePlayerStore.getState().currentTrack);
		return () => {
			removeUnlock();
			cancelHandoffRef.current?.();
			cancelHandoffRef.current = null;
			const audio = audioRef.current;
			if (audio) dropElement(audio);
			leaveDeck();
			// Clean up preload pools and cancel background prefetch
			disposePrefetchPools();
		};
	}, [attachEvents, dropElement, leaveDeck]);

	// Sign-out / account switch: forget the presigned URLs, prefetch state and
	// the IndexedDB audio the Service Worker would keep serving — and the next
	// track a gapless run lined up with them (it is lined up again, or not,
	// under the new session).
	useEffect(
		() =>
			watchSignOut(useAuthStore, () => {
				void forgetSignedInState();
				deckRef.current?.setNext(null);
				deckDeclinedRef.current = new Set();
			}),
		[]
	);

	// Stop preview when full player resumes
	useEffect(() => {
		if (currentTrack && isPlaying) {
			const preview = usePreviewStore.getState();
			if (preview.currentTrack) preview.stop();
		}
	}, [currentTrack, isPlaying]);

	// Pause (not stop) stream player when preview starts; resume when preview ends
	useEffect(() => {
		if (remote) {
			// A Preview on a Remote pauses the Active Device, which stays paused when it ends
			// (CONTEXT.md, Preview): the pause goes out as a Command.
			if (previewTrack && previewIsPlaying && usePlayerStore.getState().isPlaying) usePlayerStore.getState().pause();
			usePreviewStore.getState().setMainWasPlaying(false);
			return;
		}
		if (previewTrack && previewIsPlaying) {
			const { isPlaying: mainPlaying } = usePlayerStore.getState();
			usePreviewStore.getState().setMainWasPlaying(mainPlaying);
			if (mainPlaying) {
				const audio = audioRef.current;
				if (audio) {
					adjustVolume(audio, 0, { duration: 300 }).then(() => {
						if (!usePlayerStore.getState().isPlaying) return;
						audio.pause();
						usePlayerStore.getState().pause();
					});
				}
			}
		} else if (!previewTrack && !previewIsPlaying) {
			// Preview ended — resume main player if it was playing before
			if (usePreviewStore.getState()._mainWasPlaying && usePlayerStore.getState().currentTrack) {
				usePlayerStore.getState().resume();
			}
			usePreviewStore.getState().setMainWasPlaying(false);
		}
	}, [previewTrack, previewIsPlaying, remote]);

	// --- Preload adjacent tracks + smart background prefetch ---
	useEffect(() => {
		if (!currentTrack) return;
		const { queue, queueIndex } = usePlayerStore.getState();

		// Immediate preload of the adjacent tracks (in-memory Audio elements for
		// instant swap) — cached copies only: an uncached next track is preloaded
		// live near the end of this one (onTimeUpdate), never persisted. A
		// gapless run fetches the next track itself (and lets onTimeUpdate
		// preload it only when the run won't take it).
		if (queueIndex + 1 < queue.length && !gaplessWanted()) {
			preloadTrack(queue[queueIndex + 1].trackId);
		}
		if (queueIndex - 1 >= 0) {
			preloadTrack(queue[queueIndex - 1].trackId);
		}

		// Warm presigned URL cache for the next 3 tracks so click-to-play
		// skips the /api/v1/stream-url roundtrip.
		const upcoming: string[] = [];
		for (let i = 1; i <= 3 && queueIndex + i < queue.length; i++) {
			upcoming.push(queue[queueIndex + i].trackId);
		}
		if (queueIndex - 1 >= 0) upcoming.push(queue[queueIndex - 1].trackId);
		presignedUrls.warm(upcoming);

		// Background IndexedDB prefetch: PREFETCH_LIMIT tracks around the
		// cursor, only those the server already cached.
		smartPrefetchQueue(queue, queueIndex);
	}, [currentTrack, gaplessWanted]);

	// --- Load new track ---
	useEffect(() => {
		const audio = audioRef.current;
		if (!audio) return;

		if (!currentTrack) {
			// Stopping playback (queue cleared / explicit stop). If the last
			// track wasn't counted, it's a skip — unless the sound just moved to
			// another Device (was: a Transfer counted as a skip and evicted the track).
			if (!remoteRef.current && shouldNotifySkip(sessionRef.current)) notifyTrackSkipped(sessionRef.current.trackId);
			const stopped = sessionRef.current;
			if (stopped) {
				const reason = remoteRef.current ? "transferred" : stopped.ended ? "completed" : stopped.failed ? "failed" : "stopped";
				reportListen(stopped, reason);
			}
			sessionRef.current = null;
			// Nothing started for the stopped track may land afterwards: a URL
			// still resolving, a seek waiting for the stored file, a resume
			// position (was: the late URL loaded — and for an uncached track
			// persisted — the track the user had just stopped).
			++loadGenRef.current;
			pendingSeekRef.current = null;
			seekCheckRef.current = null;
			// The hydration render also lands here (the store's initial snapshot
			// has no track yet): keep the position restored for the page refresh
			// unless a track had really been loaded (was: refresh restarted at 0).
			if (prevTrackIdRef.current !== null) resumePositionRef.current = null;
			timers.clear();
			autoSkip.cancel();
			cancelHandoffRef.current?.();
			cancelHandoffRef.current = null;
			audio.pause();
			audio.src = "";
			leaveDeck();
			prevTrackIdRef.current = null;
			return;
		}

		if (currentTrack.trackId !== prevTrackIdRef.current) {
			// Drop any pending resume position when the user navigates to a
			// different track before the first one finishes loading.
			if (prevTrackIdRef.current !== null) {
				resumePositionRef.current = null;
			}
			// A track the user picked (not the queue's own advance) may start
			// a gapless run again after a deck failure.
			if (!autoAdvanceRef.current) gaplessBlockedRef.current = false;
			// Ends the previous session (skip notification if it never
			// reached 30 s) and resets every per-track flag.
			beginTrack(currentTrack);

			// Cancel any in-progress crossfade on manual track change
			if (crossfadeActiveRef.current) {
				crossfadeActiveRef.current = false;
				if (outgoingAudioRef.current) {
					discardElement(outgoingAudioRef.current);
					outgoingAudioRef.current = null;
				}
			}
			const gen = ++loadGenRef.current;

			// Immediately kill the old audio — hard stop, no fade. A user's
			// track change leaves a gapless run cleanly here too.
			dropElement(audio);
			leaveDeck();

			// Pick the best prefetched element, in order of buffer richness:
			//   1. queue preload (next/prev — cached copy or live preview stream)
			//   2. hover preload  (preview-mode full stream, ~30s buffered)
			//   3. head preload   (preview-mode head — ~3s buffered, must
			//                      transition to full stream when it ends)
			const taken = takePreloaded(currentTrack.trackId);
			const preloaded = taken?.audio;

			// Gapless: cached copies only — a live preview stream plays as before.
			// A preload still resolving its URL (a hover just before the click)
			// is dropped: the run resolves the URL itself (was: its empty src
			// read as "not a cached copy" and the track took the plain path).
			const resolving = !!preloaded && !preloaded.src;
			if (
				gaplessWanted() &&
				!taken?.head &&
				(!preloaded || resolving || isDeckSource(preloaded.src, window.location.origin))
			) {
				if (resolving) discardElement(preloaded);
				startTrack(currentTrack, gen, resolving ? null : (preloaded ?? null));
				return;
			}

			if (preloaded) {
				activateElement(preloaded, currentTrack);

				// If we swapped onto a head-prefetched element, kick off the
				// full stream now so it can take over before the head runs
				// out. The full stream goes through normal /stream-progressive
				// (no preview, persisting) — first listen, server downloads
				// from Deezer once and persists; subsequent plays hit Blob.
				if (taken.head) handoffFullStream(preloaded, currentTrack.trackId, gen);

				if (preloaded.readyState >= 2) {
					// Already buffered — play immediately
					setBuffering(false);
					applyResumePosition(preloaded);
					if (usePlayerStore.getState().isPlaying) {
						skipPlayEffectRef.current = true;
						startPlayback(preloaded);
					}
				}
				// If not ready yet, onCanPlay will fire and handle playback
			} else {
				// No preloaded data — load normally on a fresh element
				const newAudio = createAudioElement();
				activateElement(newAudio, currentTrack);

				getTrackUrl(currentTrack.trackId).then((url) => {
					if (loadGenRef.current !== gen) return;
					newAudio.src = url;
					newAudio.load();
				});
			}
		}
	}, [currentTrack, activateElement, beginTrack, startPlayback, dropElement, applyResumePosition, timers, autoSkip, handoffFullStream, setBuffering, leaveDeck, gaplessWanted, startTrack]);

	// --- Play / pause with fade effects ---
	useEffect(() => {
		const audio = audioRef.current;
		if (!audio || !currentTrack) return;

		if (isPlaying) {
			// Skip if loadTrack already started playback (preloaded swap)
			if (skipPlayEffectRef.current) {
				skipPlayEffectRef.current = false;
				return;
			}
			// Resuming after a long pause on a presigned URL that expired (C1
			// expiresAt): sign it again and resume at the same position instead
			// of letting the next range request fail with a 403.
			if (
				audio.readyState >= 1 &&
				needsResign({
					usableUntil: presignedUrls.usableUntil(audio.src),
					now: Date.now(),
					currentTime: audio.currentTime,
					duration: audio.duration,
					buffered: audio.buffered,
				})
			) {
				const trackId = currentTrack.trackId;
				presignedUrls.invalidate(trackId);
				reloadFrom(
					audio,
					presignedUrls.get(trackId).then((url) => url ?? proxyUrl(trackId)),
					audio.currentTime
				);
				return;
			}
			if (audio.readyState >= 2) startPlayback(audio);
		} else {
			// The next start is the user's: it fades in, even if the queue
			// advanced to this track and it never started (was: no fade-in).
			if (sessionRef.current) sessionRef.current.autoAdvance = false;
			adjustVolume(audio, 0, { duration: 500 }).then(() => {
				if (!usePlayerStore.getState().isPlaying) {
					audio.pause();
				}
			});
		}
	}, [isPlaying, currentTrack, startPlayback, reloadFrom]);

	// Volume — smooth transition
	useEffect(() => {
		const audio = audioRef.current;
		if (!audio || !isPlaying) return;
		adjustVolume(audio, volume / 100, { duration: 300 });
	}, [volume, isPlaying]);

	// Normalization toggle — back to unity when turned off (the measured gain
	// is kept and re-applied by onTimeUpdate if it's turned on again).
	useEffect(() => {
		if (!normalizationEnabled) {
			resetNormGain(audioRef.current);
			normRef.current.appliedTo = null;
		}
	}, [normalizationEnabled]);

	// Sound effects (spatialisation, equaliser): applied once the context
	// exists, and again on every change.
	const sound = usePlayerStore((s) => s.sound);
	useEffect(() => {
		setSoundEffects(sound);
	}, [sound]);

	// Retry: bumped by retryTrack() — reload the current track from scratch.
	// We preserve the current playback position across the reload so the
	// user stays on the same timeline instead of jumping back to 0.
	// applyResumePosition picks the captured time up on canplay.
	const retryLoadCount = usePlayerStore((s) => s._retryLoadCount);
	const prevRetryRef = useRef(retryLoadCount);
	useEffect(() => {
		if (retryLoadCount === prevRetryRef.current) return;
		prevRetryRef.current = retryLoadCount;
		const track = currentTrack;
		const audio = audioRef.current;
		if (!track || !audio) return;

		// Capture position before tearing the old element down. Anything <1s
		// is treated as "near the start" and skipped — that's the recovery
		// case where there's nothing to preserve.
		const liveTime = pendingSeekRef.current?.target ?? timeOf(audio);
		pendingSeekRef.current = null;
		if (isFinite(liveTime) && liveTime >= 1) {
			resumePositionRef.current = liveTime;
		}

		// Same track, fresh attempt: drop its retry budget and any pending
		// retry / auto-skip timer (was: "Retry" in the toast was followed by
		// the auto-skip that was still armed).
		if (sessionRef.current) {
			sessionRef.current.retryCount = 0;
			sessionRef.current.failed = false;
		}
		timers.clear();
		autoSkip.cancel();
		setError(null);
		setBuffering(true);
		// Force a clean reload — new audio element to drop any error state.
		const gen = ++loadGenRef.current;
		cancelHandoffRef.current?.();
		cancelHandoffRef.current = null;
		dropElement(audio);
		leaveDeck();
		const newAudio = createAudioElement();
		activateElement(newAudio);
		getTrackUrl(track.trackId).then((url) => {
			if (loadGenRef.current !== gen) return;
			newAudio.src = url;
			newAudio.load();
		});
	}, [retryLoadCount, currentTrack, activateElement, dropElement, setBuffering, setError, timers, autoSkip, timeOf, leaveDeck]);

	// Seek: respond to _seekTo signal from prev() restart or seek()
	const seekTo = usePlayerStore((s) => s._seekTo);
	useEffect(() => {
		if (seekTo === null) return;
		const audio = audioRef.current;
		const track = usePlayerStore.getState().currentTrack;
		const deck = deckOf(audio);
		if (deck) {
			// Within the current track of the run; anything not buffered is
			// re-appended from the file in memory.
			deck.seek(seekTo);
		} else if (audio && track && pendingSeekRef.current) {
			seekViaPersistedFile(audio, track.trackId, seekTo);
		} else if (audio) {
			if (
				track &&
				audio.readyState >= 1 &&
				!canSeekInPlace({
					src: audio.src,
					target: seekTo,
					seekable: audio.seekable,
					buffered: audio.buffered,
					duration: audio.duration,
				})
			) {
				seekViaPersistedFile(audio, track.trackId, seekTo);
			} else if (audio.readyState >= 1 && isFinite(audio.duration) && audio.duration > 0) {
				try {
					seekInPlace(audio, seekTo);
				} catch {
					// Buffer not yet covering the seek target — fall through to
					// queue it for after canplay/loadedmetadata.
					resumePositionRef.current = seekTo;
				}
			} else {
				// Audio metadata isn't loaded yet — defer the seek to canplay.
				resumePositionRef.current = seekTo;
			}
		}
		// Clear the signal so it doesn't re-fire
		usePlayerStore.setState({ _seekTo: null });
	}, [seekTo, seekViaPersistedFile, seekInPlace, deckOf]);

	// --- Media Session position update ---
	const onPositionUpdate = useCallback(() => {
		if (!("mediaSession" in navigator)) return;
		const audio = audioRef.current;
		if (!audio) return;
		const duration = durationOf(audio);
		if (!duration || !isFinite(duration)) return;
		try {
			navigator.mediaSession.setPositionState({
				duration,
				playbackRate: audio.playbackRate,
				position: Math.min(timeOf(audio), duration),
			});
		} catch {
			// Ignore invalid state errors
		}
	}, [durationOf, timeOf]);

	// --- Event handlers (always point to the latest closures) ---
	// Assigned after every commit rather than during render: refs must not
	// be written while rendering.
	useEffect(() => {
		// --- Gapless run ---
		// The playhead crossed into the next track of the run: the same
		// per-track reset as the load effect, which then has nothing to load.
		const advanceInRun = (deck: GaplessDeck, trackId: string) => {
			const { queue, queueIndex } = usePlayerStore.getState();
			const nextTrack = queue[queueIndex + 1];
			if (sessionRef.current) sessionRef.current.ended = true;
			if (nextTrack?.trackId !== trackId) {
				// The queue moved under the run: go on like a track that ended.
				advanceQueue(autoAdvanceRef, true, usePlayerStore);
				return;
			}
			autoAdvanceRef.current = true;
			beginTrack(nextTrack);
			setDuration(deck.trackDuration());
			usePlayerStore.getState().next();
			// next() flags the new track as buffering; it is already playing.
			setBuffering(false);
		};

		// Line up the track that follows (from halfway through this one), and
		// line up another when the queue or the settings change.
		const lineUpNext = (deck: GaplessDeck) => {
			if (deckResolvingRef.current !== null) return;
			const want = nextInRun(usePlayerStore.getState(), deckDeclinedRef.current);
			if (deck.nextDecided()) {
				if (deck.nextTrackId() === want) return;
			} else if (!gaplessNextDue(deck.trackTime(), deck.trackDuration())) {
				return;
			}
			if (!want) {
				deck.setNext(null);
				return;
			}
			deckResolvingRef.current = want;
			void getTrackUrl(want)
				.catch(() => null)
				.then((url) => {
					if (deckRef.current !== deck || deckResolvingRef.current !== want) return;
					deckResolvingRef.current = null;
					// The queue moved meanwhile: the next timeupdate lines up again.
					if (nextInRun(usePlayerStore.getState(), deckDeclinedRef.current) !== want) return;
					if (isDeckSource(url, window.location.origin)) {
						deck.setNext({ trackId: want, url });
					} else {
						// Not cached (the run never plays the live stream).
						deckDeclinedRef.current.add(want);
						deck.setNext(null);
					}
				});
		};

		handlersRef.current.onCanPlay = () => {
			const audio = audioRef.current;
			if (!audio) return;
			setBuffering(false);
			setDuration(durationOf(audio) || 0);
			applyResumePosition(audio);
			onPositionUpdate();
			if (usePlayerStore.getState().isPlaying) {
				// Only start (and fade in) if not already playing — prevents a
				// double fade when canplay fires after we already started the element.
				if (audio.paused) startPlayback(audio);
				else adjustVolume(audio, usePlayerStore.getState().volume / 100, { duration: 200 });
			}
		};

		handlersRef.current.onTimeUpdate = () => {
			const audio = audioRef.current;
			if (!audio) return;
			const deck = deckOf(audio);
			if (deck) {
				const crossed = deck.sync();
				if (crossed) advanceInRun(deck, crossed);
				if (deckRef.current === deck) lineUpNext(deck);
			}
			// An in-place seek on the live stream that snapped back to the start
			// (the browser thought it could range it): use the stored file.
			const check = seekCheckRef.current;
			if (check && !audio.seeking) {
				seekCheckRef.current = null;
				const track = usePlayerStore.getState().currentTrack;
				if (check.element === audio && track && !seekLanded(check.target, audio.currentTime)) {
					seekViaPersistedFile(audio, track.trackId, check.target);
					return;
				}
			}
			// Don't write timeUpdates back to the store while a seek is pending —
			// audio.currentTime may briefly be the pre-seek value, which would
			// rubber-band the SeekBar visually after the user releases.
			if (usePlayerStore.getState()._seekTo !== null || pendingSeekRef.current) {
				onPositionUpdate();
				return;
			}
			// Throttle store writes to ~4Hz to avoid excessive re-renders
			const now = timeOf(audio);
			const last = usePlayerStore.getState().currentTime;
			if (Math.abs(now - last) >= 0.25) {
				setCurrentTime(now);
			}
			onPositionUpdate();

			// Spotify rule: count a real play once 30 s were actually listened
			// to (was: currentTime >= 30, so a seek past 0:30 counted).
			// This is the moment the track "joins" the user's recently-played
			// history and its stored file is locked from eviction-on-skip.
			const track = usePlayerStore.getState().currentTrack;
			const session = sessionRef.current;
			if (session && !audio.paused && !audio.seeking) accumulateListened(session, now);
			if (
				track &&
				session &&
				!session.logged &&
				session.trackId === track.trackId &&
				reachedPlayThreshold(session)
			) {
				session.logged = true;
				void logRecentPlay({
					trackId: track.trackId,
					title: track.title,
					artist: track.artist,
					album: track.album,
					albumId: track.albumId,
					cover: track.cover,
					duration: track.duration,
				});

				// If this track is playing from a preview-mode prefetch, the server
				// didn't persist it — start a persisting stream in the background
				// (once per play).
				if (claimBackgroundPersist(session, audio.src || "")) persistInBackground(track.trackId);
				// A track really listened to is worth keeping in IndexedDB: read
				// from its presigned R2 URL, not a second trip through the server.
				if (classifySource(deck ? deck.sourceUrl() : audio.src) !== "blob") void cacheListenedTrack(track.trackId);
			}

			// Route the element through Web Audio (visualiser, normalisation,
			// GainNode volume) once a gesture got the context running — never
			// into a suspended context, which would play silence. Idempotent.
			if (isAudioCtxRunning()) routeElement(audio);

			// Normalisation (if enabled): average this track's level over
			// several seconds, then apply one gain to its element(s).
			const norm = normRef.current;
			if (normalizationEnabled && isRouted(audio)) {
				if (norm.gain === null && !audio.paused) {
					const level = readLevel(audio);
					if (level) norm.meter.add(level, now);
					norm.gain = norm.meter.gain();
				}
				if (norm.gain !== null && norm.appliedTo !== audio) {
					setNormGain(audio, norm.gain);
					norm.appliedTo = audio;
				}
			}

			// Preload the next track: a cached copy from halfway through; an
			// uncached one only through the live preview stream, and only close
			// to the end so it neither persists nor idles on a server function.
			// A gapless run lines its next track up itself, unless it won't take it.
			const duration = durationOf(audio);
			const runTakesNext = !!deck && (!deck.nextDecided() || deck.nextTrackId() !== null);
			if (duration > 0 && !runTakesNext) {
				const left = duration - now;
				const live = left <= Math.max(LIVE_PRELOAD_LEAD_S, crossfadeDuration + 10);
				if (live || now / duration > 0.5) {
					const { queue, queueIndex } = usePlayerStore.getState();
					if (queueIndex + 1 < queue.length) preloadTrack(queue[queueIndex + 1].trackId, { live });
				}
			}

			// --- Crossfade --- (never from a gapless run: crossfade turned on
			// mid-run ends the run at this track's end)
			const timeLeft = audio.duration - audio.currentTime;
			if (
				!deck &&
				crossfadeDuration > 0 &&
				!crossfadeActiveRef.current &&
				audio.duration > crossfadeDuration * 2 && // skip very short tracks
				timeLeft > 0 &&
				timeLeft <= crossfadeDuration &&
				repeat !== "one"
			) {
				const { queue, queueIndex, repeat: rep } = usePlayerStore.getState();

				// Determine next queue index (mirrors next() logic). The queue is
				// already in physical play order — shuffle just reorders it ahead
				// of time — so plain queueIndex+1 covers both modes.
				let nextQueueIndex = -1;
				if (queueIndex + 1 < queue.length) nextQueueIndex = queueIndex + 1;
				else if (rep === "all") nextQueueIndex = 0;

				if (nextQueueIndex >= 0) {
					const nextTrack = queue[nextQueueIndex];
					const preloaded = queuePreloaded(nextTrack.trackId);

					if (preloaded && preloaded.readyState >= 3) {
						crossfadeActiveRef.current = true;
						const fadeDuration = timeLeft * 1000;

						// Detach events from outgoing audio so its onended doesn't trigger next()
						const outgoing = audio;
						detachEvents(outgoing);
						outgoingAudioRef.current = outgoing;

						// Swap to incoming audio. beginTrack runs the same per-track
						// reset as the load effect, which next() below then skips
						// (was: plays via crossfade were never logged, the duration,
						// retry budget and normalisation stayed the previous track's).
						// Not flagged as an auto-advance: the crossfade ramps the
						// volume itself, and the flag would make the next user
						// resume skip its fade-in.
						takePreloaded(nextTrack.trackId);
						if (sessionRef.current) sessionRef.current.ended = true;
						beginTrack(nextTrack);
						activateElement(preloaded, nextTrack);
						skipPlayEffectRef.current = true;

						setElementVolume(preloaded, 0);
						preloaded.currentTime = 0;
						preloaded.play().catch(() => {});

						const targetVol = usePlayerStore.getState().volume / 100;
						adjustVolume(outgoing, 0, { duration: fadeDuration });
						adjustVolume(preloaded, targetVol, { duration: fadeDuration });

						// Advance store state to next track
						usePlayerStore.getState().next();
						// next() flags the new track as buffering; this one is already playing.
						setBuffering(false);

						// Clean up outgoing after fade
						// (only this crossfade's state: a track change meanwhile
						// already dropped it, and may have started another one).
						setTimeout(() => {
							discardElement(outgoing);
							if (outgoingAudioRef.current !== outgoing) return;
							outgoingAudioRef.current = null;
							crossfadeActiveRef.current = false;
						}, fadeDuration + 300);
					}
				}
			}
		};

		handlersRef.current.onEnded = () => {
			if (repeat === "one") {
				// Each time round is a play of its own in the listening log.
				reportListen(sessionRef.current, "completed");
				const audio = audioRef.current;
				if (audio) {
					// A gapless run's element plays several tracks: back to this one's start.
					const deck = deckOf(audio);
					if (deck) deck.seek(0);
					else audio.currentTime = 0;
					audio.play().catch(() => {});
				}
			} else {
				if (sessionRef.current) sessionRef.current.ended = true;
				// Queue advance: the next track starts without a fade-in.
				advanceQueue(autoAdvanceRef, true, usePlayerStore);
			}
		};

		handlersRef.current.onError = () => {
			const audio = audioRef.current;
			if (!audio || !currentTrack) return;
			const deck = deckOf(audio);
			if (deck) {
				// A decode / Media Source error: this track goes on on the plain path.
				console.warn("[AudioEngine] gapless deck error — back to the plain path", {
					trackId: currentTrack.trackId,
					mediaErrorCode: audio.error?.code,
					mediaErrorMessage: audio.error?.message,
				});
				leaveDeckForPlain(deck);
				return;
			}
			const src = audio.src;
			const mediaErr = audio.error;
			const session = sessionRef.current;
			const source = classifySource(src, window.location.origin);
			console.warn("[AudioEngine] playback error", {
				trackId: currentTrack.trackId,
				title: currentTrack.title,
				src,
				source,
				currentSrc: audio.currentSrc,
				retryCount: session?.retryCount,
				mediaErrorCode: mediaErr?.code,
				mediaErrorMessage: mediaErr?.message,
				networkState: audio.networkState,
				readyState: audio.readyState,
			});

			// A signed-out session gets the same 401 on every retry — go straight
			// to the diagnosis instead of burning the retry budget.
			const { isAuthenticated, isLoading: authLoading } = useAuthStore.getState();
			const knownGuest = !authLoading && !isAuthenticated;
			const trackId = currentTrack.trackId;
			const position = pendingSeekRef.current?.target ?? audio.currentTime;
			const recovery = planRecovery({
				source,
				resigned: !!session?.resigned,
				urlExpired: presignedUrls.isExpired(src),
				retryCount: session?.retryCount ?? MAX_RETRIES,
				maxRetries: MAX_RETRIES,
				knownGuest,
			});

			switch (recovery.action) {
				case "evict-blob":
					// Corrupt IndexedDB copy: remove it and play from the network
					// (was: a bad blob disabled presigned URLs and stayed cached).
					void removeCached(trackId);
					reloadFrom(audio, getTrackUrl(trackId, { skipBlob: true }), position);
					return;
				case "resign":
					// The presigned URL most likely expired during a long pause:
					// sign it again once and resume at the same position.
					if (session) session.resigned = true;
					presignedUrls.invalidate(trackId);
					reloadFrom(
						audio,
						presignedUrls.get(trackId).then((url) => url ?? proxyUrl(trackId)),
						position
					);
					return;
				case "proxy":
					// Presigned playback failed for this track: refuse it for this
					// track only (was: a session-wide kill switch) and resume on the
					// range-capable proxy.
					presignedUrls.deny(trackId);
					reloadFrom(audio, Promise.resolve(proxyUrl(trackId)), position);
					return;
				case "retry": {
					// The timer is bound to this element and this track: a track
					// change, a reload or a manual retry clears it, and it re-checks
					// on fire (was: the retry loaded the old track's stream into the
					// next track's element).
					if (session) session.retryCount++;
					const scheduled = currentTarget();
					timers.after(recovery.delayMs, () => {
						if (!sameTarget(scheduled, currentTarget())) return;
						// Re-resolve (the track may be stored by now) and resume
						// where it broke instead of restarting the live stream at 0.
						reloadFrom(audio, getTrackUrl(trackId, { skipBlob: true }), position);
					});
					return;
				}
			}

			// All retries exhausted — ask the route once (?probe=1, C3: no audio
			// is opened or stored) so we can surface the server's actual error
			// (the <audio> element only sees "Format error") and react to
			// account-wide failures. The track failed: leaving it isn't a skip.
			if (session) session.failed = true;
			const failingTrack = currentTrack;
			void diagnoseStreamFailure(progressiveUrl(failingTrack.trackId, { probe: true })).then(
				(diagnosis) => {
					if (diagnosis.error) {
						console.error("[AudioEngine] giving up — fetch failed", diagnosis.error);
					} else if (diagnosis.status && diagnosis.status >= 400) {
						console.error(`[AudioEngine] giving up — server says ${diagnosis.status}`, {
							trackId: failingTrack.trackId,
							finalUrl: diagnosis.url,
							errorCode: diagnosis.code,
							errorMessage: diagnosis.message,
							body: diagnosis.body,
						});
					}
					// The user moved on while we were probing — nothing to report.
					if (usePlayerStore.getState().currentTrack?.trackId !== failingTrack.trackId) return;
					handleGiveUp(failingTrack, diagnosis.kind);
				}
			);
		};

		const skipTo = (reason: SkipReason) => advanceQueue(autoAdvanceRef, reason === "auto", usePlayerStore);

		const handleGiveUp = (failingTrack: PlayerTrack, kind: StreamFailureKind) => {
			// Auth / Deezer problems fail every track the same way: stop here
			// instead of skipping through the queue with "Can't play".
			if (kind === "auth" || kind === "deezer") {
				consecutiveFailuresRef.current = 0;
				pause();
				const signIn = kind === "auth";
				const title = signIn ? "Sign in to play full tracks" : "Connect your Deezer account";
				setError(title);
				toast.error(title, {
					id: "stream-account-error",
					description: signIn
						? "Your session has expired or you're not signed in."
						: "Add a valid Deezer ARL in Settings to stream tracks.",
					duration: 10000,
					action: {
						label: signIn ? "Sign in" : "Settings",
						// Client-side navigation: a full load would stop playback and reset the app.
						onClick: () => router.push(signIn ? currentLoginHref() : "/settings"),
					},
				});
				return;
			}

			// Count this as a queue-wide failure
			consecutiveFailuresRef.current++;

			if (consecutiveFailuresRef.current >= MAX_CONSECUTIVE_FAILURES) {
				// Multiple tracks failing back-to-back almost always means a
				// network/auth problem, not isolated bad files. Stop auto-skipping
				// so we don't silently chew through the queue.
				setError(`Multiple tracks failed to load. Check your connection.`);
				pause();
				toast.error("Multiple tracks failed to load", {
					description: "Check your connection and try again.",
					duration: 8000,
					action: {
						label: "Retry",
						onClick: () => {
							consecutiveFailuresRef.current = 0;
							usePlayerStore.getState().retryTrack();
						},
					},
				});
				return;
			}

			setError(`Can't play "${failingTrack.title}"`);
			const { queue, queueIndex } = usePlayerStore.getState();
			const hasNext = queueIndex + 1 < queue.length;

			// The auto-skip only ever skips the failing track, once: "Skip",
			// "Retry" or a manual track change cancel it (was: an unconditional
			// setTimeout(next) skipped twice after "Skip", skipped after "Retry"
			// and skipped a track picked by hand in the meantime).
			toast.error(`Can't play "${failingTrack.title}"`, {
				description: failingTrack.artist,
				duration: hasNext ? 5000 : 8000,
				action: {
					label: "Retry",
					onClick: () => {
						autoSkip.cancel();
						usePlayerStore.getState().retryTrack();
					},
				},
				cancel: hasNext
					? {
							label: "Skip",
							onClick: () => autoSkip.skipNow(failingTrack.trackId, skipTo),
						}
					: undefined,
			});

			if (hasNext) {
				autoSkip.arm(failingTrack.trackId, 1500, skipTo);
			} else {
				pause();
			}
		};

		handlersRef.current.onLoadedMetadata = () => {
			const audio = audioRef.current;
			if (audio) setDuration(durationOf(audio) || 0);
		};

		handlersRef.current.onWaiting = () => {
			setBuffering(true);
		};

		handlersRef.current.onPlaying = () => {
			setBuffering(false);
			// Successful playback resets the consecutive-failure streak.
			consecutiveFailuresRef.current = 0;
			const audio = audioRef.current;
			const session = sessionRef.current;
			if (audio && session) {
				// The listen starts with the sound, not with the load.
				if (session.playedFrom === null && !session.reportedOnce) session.listenStartedAt = Date.now();
				session.playedFrom = audio.src;
			}
		};

		handlersRef.current.onProgress = () => {
			const audio = audioRef.current;
			if (!audio) return;
			const deck = deckOf(audio);
			if (deck) {
				setBuffered(deck.bufferedEnd());
				return;
			}
			const ranges = audio.buffered;
			if (ranges.length === 0) {
				setBuffered(0);
				return;
			}
			// Use the end of the last range — for HLS-like progressive streams this
			// reflects how much the browser has buffered ahead of currentTime.
			setBuffered(ranges.end(ranges.length - 1));
		};
	});

	// --- Media Session API ---

	useEffect(() => {
		if (!("mediaSession" in navigator)) return;

		if (!currentTrack) {
			navigator.mediaSession.metadata = null;
			return;
		}

		navigator.mediaSession.metadata = new MediaMetadata(mediaMetadataInit(currentTrack));
	}, [currentTrack]);

	useEffect(() => {
		if (!("mediaSession" in navigator)) return;
		navigator.mediaSession.playbackState = currentTrack
			? isPlaying
				? "playing"
				: "paused"
			: "none";
	}, [isPlaying, currentTrack]);

	useEffect(() => {
		if (!("mediaSession" in navigator)) return;

		const actions: [MediaSessionAction, MediaSessionActionHandler][] = [
			["play", () => resume()],
			["pause", () => pause()],
			["previoustrack", () => prev()],
			["nexttrack", () => next()],
			["stop", () => usePlayerStore.getState().stop()],
			[
				"seekto",
				(details) => {
					if (details.seekTime != null) {
						usePlayerStore.getState().seek(details.seekTime);
					}
				},
			],
			[
				"seekbackward",
				(details) => {
					const audio = audioRef.current;
					if (audio) {
						const offset = details.seekOffset ?? 10;
						usePlayerStore.getState().seek(Math.max(0, timeOf(audio) - offset));
					}
				},
			],
			[
				"seekforward",
				(details) => {
					const audio = audioRef.current;
					if (audio) {
						const offset = details.seekOffset ?? 10;
						usePlayerStore.getState().seek(Math.min(durationOf(audio) || 0, timeOf(audio) + offset));
					}
				},
			],
		];

		for (const [action, handler] of actions) {
			try {
				navigator.mediaSession.setActionHandler(action, handler);
			} catch {
				// Action not supported by browser
			}
		}

		return () => {
			for (const [action] of actions) {
				try {
					navigator.mediaSession.setActionHandler(action, null);
				} catch {}
			}
		};
	}, [pause, resume, prev, next, timeOf, durationOf]);

	// No JSX audio element — all managed imperatively for preload swapping
	return null;
}
