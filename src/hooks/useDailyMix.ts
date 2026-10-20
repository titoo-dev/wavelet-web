"use client";

import { useCallback, useEffect, useState } from "react";
import { useAuthStore } from "@/stores/useAuthStore";
import type { DailyMix } from "@/lib/daily-mix";

export type DailyMixState = { status: "loading" } | { status: "ready"; mix: DailyMix } | { status: "error" };

/** The viewer's own date (YYYY-MM-DD): the mix changes at their midnight, not the server's. */
export function localDay(now = new Date()): string {
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

async function fetchMix(refresh: boolean): Promise<DailyMixState> {
	try {
		const res = await fetch(`/api/v1/mixes/daily?day=${localDay()}${refresh ? "&refresh=1" : ""}`, { credentials: "include" });
		const json = await res.json();
		return json?.success ? { status: "ready", mix: json.data as DailyMix } : { status: "error" };
	} catch {
		return { status: "error" };
	}
}

/** The signed-in user's Daily Mix (GET /api/v1/mixes/daily); `refresh` builds a new one. */
export function useDailyMix() {
	const signedIn = useAuthStore((s) => s.isAuthenticated);
	const [state, setState] = useState<DailyMixState>({ status: "loading" });

	useEffect(() => {
		if (!signedIn) return;
		let cancelled = false;
		void fetchMix(false).then((s) => {
			if (!cancelled) setState(s);
		});
		return () => {
			cancelled = true;
		};
	}, [signedIn]);

	const refresh = useCallback(async () => {
		setState({ status: "loading" });
		setState(await fetchMix(true));
	}, []);

	return { state, refresh };
}
