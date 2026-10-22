// Per-track playback state for AudioEngine. Every flag that must start over
// when a new track becomes current lives in one TrackSession object, so an
// activation path (load, preload hit, crossfade, handoff, retry) can't
// forget to reset one of them: starting a track = replacing the session.

import { isPreviewSource } from "@/lib/seek";
import type { ListenEndReason, ListenInput } from "@/lib/listens";

/** Spotify rule: a play counts once this much of the track was listened to. */
export const PLAY_THRESHOLD_SECONDS = 30;

export interface TrackSession {
	readonly trackId: string;
	/** Started by the queue (track ended, crossfade, auto-skip) rather than by the user. */
	autoAdvance: boolean;
	/** The 30 s play was logged (POST /recent-plays). */
	logged: boolean;
	/** Retries burnt on the live stream for this track. */
	retryCount: number;
	/** A fresh presigned URL was already tried after an error. */
	resigned: boolean;
	/** persistInBackground() was already opened for this play. */
	persistRequested: boolean;
	/** Seconds actually played (seeks and pauses excluded). */
	listened: number;
	/** Playback position at the previous timeupdate (null = none yet). */
	lastPosition: number | null;
	/** The source playback last started from (the "playing" event). */
	playedFrom: string | null;
	/** The engine gave up on this track (retries exhausted). */
	failed: boolean;
	/** The track ran to its end (ended event, crossfade or gapless hand-over). */
	ended: boolean;
	/** Ids and duration sent with the listen (POST /listens). */
	readonly meta: ListenMeta;
	/** Start of the play not yet reported to the listening log (epoch ms). */
	listenStartedAt: number;
	/** `listened` already reported (a repeat or a closed page reports a part). */
	listenReported: number;
	/** A part of this play was reported already. */
	reportedOnce: boolean;
}

export interface ListenMeta {
	artistId?: string | null;
	albumId?: string | null;
	/** Seconds, as the player store has it. */
	duration?: number | null;
	/** How the track got into the queue ("autoplay"…). */
	source?: string | null;
}

export function createTrackSession(
	trackId: string,
	opts: { autoAdvance?: boolean; meta?: ListenMeta; now?: number } = {}
): TrackSession {
	return {
		trackId,
		autoAdvance: !!opts.autoAdvance,
		logged: false,
		retryCount: 0,
		resigned: false,
		persistRequested: false,
		listened: 0,
		lastPosition: null,
		playedFrom: null,
		failed: false,
		ended: false,
		meta: opts.meta ?? {},
		listenStartedAt: opts.now ?? Date.now(),
		listenReported: 0,
		reportedOnce: false,
	};
}

/**
 * Why the current track's play is over when another track takes its place:
 * it failed, it ran to its end, or the user moved on.
 */
export function endReasonOf(session: TrackSession): ListenEndReason {
	if (session.failed) return "failed";
	return session.ended ? "completed" : "skipped";
}

/**
 * The listen to report for the part of this play not reported yet, then
 * start a new part (a repeat of the same track, or the page coming back
 * from the bfcache, reports separately). Null when the track never started
 * playing, or when nothing was played since the last report.
 */
export function takeListen(
	session: TrackSession | null,
	reason: ListenEndReason,
	opts: { client: string; shuffle: boolean; now?: number }
): ListenInput | null {
	if (!session || session.playedFrom === null) return null;
	const now = opts.now ?? Date.now();
	const played = Math.max(0, session.listened - session.listenReported);
	if (session.reportedOnce && played === 0) return null;
	const { artistId, albumId, duration, source } = session.meta;
	const listen: ListenInput = {
		trackId: session.trackId,
		artistId: artistId ?? null,
		albumId: albumId ?? null,
		startedAt: new Date(session.listenStartedAt).toISOString(),
		endedAt: new Date(now).toISOString(),
		msPlayed: Math.round(played * 1000),
		durationMs: duration && duration > 0 ? Math.round(duration * 1000) : null,
		endReason: reason,
		client: opts.client,
		shuffle: opts.shuffle,
		source: source ?? null,
	};
	session.listenReported = session.listened;
	session.listenStartedAt = now;
	session.reportedOnce = true;
	return listen;
}

/** Longest gap between two timeupdates still counted as continuous playback. */
export const MAX_LISTEN_TICK_SECONDS = 2;

/**
 * Add the time played since the previous timeupdate. A jump forward (seek)
 * or backward isn't listening; neither is a gap longer than a normal tick.
 */
export function accumulateListened(session: TrackSession, position: number): void {
	const prev = session.lastPosition;
	session.lastPosition = position;
	if (prev === null || !isFinite(position)) return;
	const delta = position - prev;
	if (delta > 0 && delta <= MAX_LISTEN_TICK_SECONDS) session.listened += delta;
}

/** The track was listened to long enough to count as a play (Spotify's 30 s rule). */
export function reachedPlayThreshold(session: TrackSession): boolean {
	return session.listened >= PLAY_THRESHOLD_SECONDS;
}

/**
 * A track playing from a preview stream (hover / queue preload) isn't being
 * stored by the server. Persisting it is only worth it for the track that is
 * actually playing — once per play, however many seeks or thresholds ask.
 */
export function claimBackgroundPersist(session: TrackSession | null, src: string): boolean {
	if (!session || session.persistRequested || !isPreviewSource(src)) return false;
	session.persistRequested = true;
	return true;
}

/**
 * Ask the server to evict the file of a track left before it counted as a
 * play (the skip endpoint keeps anything still referenced). Not for a track
 * that failed (the user didn't skip it), nor one that only played from a
 * preview stream — that play never stored anything.
 */
export function shouldNotifySkip(session: TrackSession | null): session is TrackSession {
	if (!session || session.logged || session.failed) return false;
	return !(session.playedFrom && isPreviewSource(session.playedFrom));
}

/**
 * Advance the queue. `auto` marks the move as the queue's own (track ended,
 * auto-skip) so the next track starts without a fade-in; the flag is dropped
 * again when next() didn't start another track (queue exhausted → stop).
 */
export function advanceQueue(
	autoAdvanceRef: { current: boolean },
	auto: boolean,
	store: { getState(): { currentTrack: unknown; next(): void } }
): void {
	const before = store.getState().currentTrack;
	autoAdvanceRef.current = auto;
	store.getState().next();
	const after = store.getState().currentTrack;
	if (!after || after === before) autoAdvanceRef.current = false;
}

/**
 * Volume ramp for the first play() of a track. A user-initiated start fades
 * in; a queue advance starts at full volume so the gap between two tracks
 * doesn't get a 200 ms dip on top of it.
 */
export function startVolume(autoAdvance: boolean, target: number): { from: number; fadeMs: number } {
	return autoAdvance ? { from: target, fadeMs: 0 } : { from: 0, fadeMs: 200 };
}
