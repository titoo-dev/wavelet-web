"use client";

import { useEffect, useRef } from "react";
import { usePlayerStore, type PlayerTrack } from "@/stores/usePlayerStore";
import { useAuthStore } from "@/stores/useAuthStore";
import { useSyncStore } from "@/lib/playback-sync/useSyncStore";

/** Tracks before the current one sent as seeds (the current one leads). */
const SEEDS = 5;
/** Queue tracks sent so they are not offered again. */
const EXCLUDE = 500;

export interface AutoplayInput {
	autoplay: boolean;
	isPlaying: boolean;
	repeat: "off" | "all" | "one";
	currentTrack: PlayerTrack | null;
	queue: PlayerTrack[];
	queueIndex: number;
}

export interface AutoplayRequest {
	/** One request per last track of a queue. */
	key: string;
	afterTrackId: string;
	body: { seeds: { trackId: string; artistId: string | null }[]; exclude: string[] };
}

/**
 * The autoplay request to send now, if any: the last track of the queue is
 * playing, repeat is off and autoplay is on.
 */
export function autoplayRequestFor(s: AutoplayInput): AutoplayRequest | null {
	const { currentTrack, queue, queueIndex } = s;
	if (!s.autoplay || !s.isPlaying || s.repeat !== "off" || !currentTrack) return null;
	if (queue.length === 0 || queueIndex !== queue.length - 1 || queue[queueIndex]?.trackId !== currentTrack.trackId) return null;
	const seeds = queue
		.slice(Math.max(0, queueIndex - SEEDS + 1), queueIndex + 1)
		.reverse()
		.map((t) => ({ trackId: String(t.trackId), artistId: t.artistId ? String(t.artistId) : null }));
	return {
		key: `${currentTrack.trackId}@${queueIndex}/${queue.length}`,
		afterTrackId: currentTrack.trackId,
		body: { seeds, exclude: queue.slice(-EXCLUDE).map((t) => String(t.trackId)) },
	};
}

/**
 * Autoplay (Spotify's): when the last track of the queue starts, similar
 * tracks are appended (POST /api/v1/autoplay) so the music goes on. Only on
 * the Device that plays: a Remote's queue is the Active Device's.
 */
export function useAutoplay() {
	const signedIn = useAuthStore((s) => s.isAuthenticated);
	const remote = useSyncStore((s) => s.role === "remote");
	const requested = useRef(new Set<string>());

	useEffect(() => {
		if (!signedIn || remote) return;
		const check = (s: AutoplayInput) => {
			const req = autoplayRequestFor(s);
			if (!req || requested.current.has(req.key)) return;
			requested.current.add(req.key);
			fetch("/api/v1/autoplay", {
				method: "POST",
				credentials: "include",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(req.body),
			})
				.then((r) => r.json())
				.then((json) => {
					const tracks = json?.success ? (json.data?.tracks as PlayerTrack[] | undefined) : undefined;
					if (tracks?.length) usePlayerStore.getState().appendAutoplay(tracks, req.afterTrackId);
				})
				.catch(() => {
					// No autoplay this time: the queue just ends.
				});
		};
		check(usePlayerStore.getState());
		return usePlayerStore.subscribe(check);
	}, [signedIn, remote]);
}
