"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { fetchData } from "@/utils/api";
import { hasMorePages, type SearchTab } from "./search-model";
import type { GwResults } from "@/lib/deezer/gw";

const PAGE = 100;
/** Overviews by term, so going back to a search is instant. */
const mainCache = new Map<string, GwResults>();

/** `search/main` overview for [term]: drives "All" and the pill counts. */
export function useMainSearch(term: string) {
	const [state, setState] = useState<{ term: string; data: GwResults; error: string | null } | null>(null);
	const [nonce, setNonce] = useState(0);

	useEffect(() => {
		if (!term || mainCache.has(term)) return;
		let live = true;
		fetchData("search/main", { term })
			.then((data) => {
				mainCache.set(term, data);
				if (mainCache.size > 20) mainCache.delete(mainCache.keys().next().value!);
				if (live) setState({ term, data, error: null });
			})
			.catch((e) => live && setState({ term, data: null, error: e instanceof Error ? e.message : "Search failed" }));
		return () => {
			live = false;
		};
	}, [term, nonce]);

	const cached = mainCache.get(term);
	const ready = state?.term === term;
	return {
		data: cached ?? (ready ? state.data : null),
		error: !cached && ready ? state.error : null,
		loading: !!term && !cached && !ready,
		retry: useCallback(() => {
			setState(null);
			setNonce((n) => n + 1);
		}, []),
	};
}

interface Page {
	data: GwResults[];
	total?: number;
}

/** Paged `search?type=` results for a single type, with `loadMore`. */
export function useTypedSearch(term: string, tab: SearchTab) {
	const key = `${tab}\u0000${term}`;
	const [state, setState] = useState<{ key: string; page: Page | null; error: string | null } | null>(null);
	const [loadingMore, setLoadingMore] = useState(false);
	const [nonce, setNonce] = useState(0);
	const busy = useRef(false);

	useEffect(() => {
		if (!term || tab === "all") return;
		let live = true;
		fetchData("search", { term, type: tab, start: "0", nb: String(PAGE) })
			.then((d) => live && setState({ key, page: { data: d?.data ?? [], total: d?.total }, error: null }))
			.catch((e) => live && setState({ key, page: null, error: e instanceof Error ? e.message : "Search failed" }));
		return () => {
			live = false;
		};
	}, [key, term, tab, nonce]);

	const ready = state?.key === key;
	const page = ready ? state.page : null;
	const more = hasMorePages(page);

	const loadMore = useCallback(async () => {
		if (!page || !more || busy.current) return;
		busy.current = true;
		setLoadingMore(true);
		try {
			const d = await fetchData("search", { term, type: tab, start: String(page.data.length), nb: String(PAGE) });
			setState((prev) =>
				prev?.key === key && prev.page
					? { ...prev, page: { data: [...prev.page.data, ...(d?.data ?? [])], total: d?.data?.length ? (d?.total ?? prev.page.total) : prev.page.data.length } }
					: prev
			);
		} catch {
			// keep what we have; the sentinel can try again
		}
		busy.current = false;
		setLoadingMore(false);
	}, [page, more, term, tab, key]);

	return {
		page,
		error: ready ? state.error : null,
		loading: !ready,
		hasMore: more,
		loadingMore,
		loadMore,
		retry: useCallback(() => {
			setState(null);
			setNonce((n) => n + 1);
		}, []),
	};
}
