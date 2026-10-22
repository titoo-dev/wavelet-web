"use client";

import { useCallback, useEffect, useState } from "react";
import { useAuthStore } from "@/stores/useAuthStore";
import type { AutoplayTrack } from "@/lib/autoplay";
import type { PlayerTrack } from "@/stores/usePlayerStore";

/** How tracks played from a song radio are tagged in the queue and the listening log. */
export const TRACK_RADIO_SOURCE = "track-radio";

/** `GET /api/v1/tracks/{id}/radio`: the seed and the songs like it. */
export interface TrackRadio {
	seed: AutoplayTrack;
	tracks: AutoplayTrack[];
}

export type TrackRadioState =
	| { status: "loading" }
	| { status: "ready"; radio: TrackRadio }
	| { status: "missing" }
	| { status: "error" }
	| { status: "signed-out" };

/** What Play plays: the seed, then the songs like it, tagged `track-radio`. */
export function radioQueue(radio: TrackRadio): PlayerTrack[] {
	return [radio.seed, ...radio.tracks].map((t) => ({ ...t, source: TRACK_RADIO_SOURCE }));
}

/** Whether every song of the radio comes after the current track. */
export function radioIsUpNext(radio: TrackRadio, queue: PlayerTrack[], queueIndex: number): boolean {
	if (radio.tracks.length === 0) return false;
	const upNext = new Set(queue.slice(queueIndex + 1).map((t) => t.trackId));
	return radio.tracks.every((t) => upNext.has(t.trackId));
}

async function fetchRadio(trackId: string): Promise<TrackRadioState> {
	try {
		const res = await fetch(`/api/v1/tracks/${encodeURIComponent(trackId)}/radio`, { credentials: "include" });
		if (res.status === 401) return { status: "signed-out" };
		if (res.status === 400 || res.status === 404) return { status: "missing" };
		const json = await res.json();
		return json?.success ? { status: "ready", radio: json.data as TrackRadio } : { status: "error" };
	} catch {
		return { status: "error" };
	}
}

/** The song radio of a Deezer track (`trackId` null: nothing to load); `retry` asks again. */
export function useTrackRadio(trackId: string | null) {
	const signedIn = useAuthStore((s) => s.isAuthenticated);
	const authLoading = useAuthStore((s) => s.isLoading);
	const [result, setResult] = useState<{ key: string; state: TrackRadioState } | null>(null);
	const [attempt, setAttempt] = useState(0);
	const key = `${trackId}\u0000${attempt}`;

	useEffect(() => {
		if (!trackId || !signedIn) return;
		let cancelled = false;
		const k = `${trackId}\u0000${attempt}`;
		void fetchRadio(trackId).then((state) => {
			if (!cancelled) setResult({ key: k, state });
		});
		return () => {
			cancelled = true;
		};
	}, [trackId, signedIn, attempt]);

	const retry = useCallback(() => setAttempt((a) => a + 1), []);

	let state: TrackRadioState;
	if (!trackId) state = { status: "missing" };
	else if (!signedIn) state = authLoading ? { status: "loading" } : { status: "signed-out" };
	else state = result?.key === key ? result.state : { status: "loading" };
	return { state, retry };
}
