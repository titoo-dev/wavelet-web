"use client";

import { useEffect, useState, useCallback } from "react";
import { useAuthStore } from "@/stores/useAuthStore";

interface SavedAlbum {
	id: string;
	deezerAlbumId: string;
}

/** Shared empty map (never written to). */
const NO_ALBUMS = new Map<string, string>();

/** The saved albums as `deezerAlbumId → Album.id`; null when they can't be read. */
async function loadAlbumMap(): Promise<Map<string, string> | null> {
	try {
		const res = await fetch("/api/v1/library/albums", { credentials: "include" });
		if (!res.ok) return null;
		const json = await res.json();
		const items = (json?.data?.items as SavedAlbum[] | undefined) || [];
		const map = new Map<string, string>();
		for (const a of items) {
			map.set(String(a.deezerAlbumId), String(a.id));
		}
		return map;
	} catch {
		return null;
	}
}

/**
 * Returns a Map of `deezerAlbumId → internal Album.id` for the user's
 * saved albums. Used to route "Saved" badges + "Open library album" links.
 * Empty while signed out; an answer that lands after sign-out is dropped.
 */
export function useDownloadedAlbums() {
	const [albumMap, setAlbumMap] = useState<Map<string, string>>(NO_ALBUMS);
	const isAuthenticated = useAuthStore((s) => s.isAuthenticated);

	const refresh = useCallback(async () => {
		const map = await loadAlbumMap();
		if (map) setAlbumMap(map);
	}, []);

	useEffect(() => {
		if (!isAuthenticated) return;
		let current = true;
		loadAlbumMap().then((map) => {
			if (current && map) setAlbumMap(map);
		});
		return () => {
			current = false;
		};
	}, [isAuthenticated]);

	return { albumMap: isAuthenticated ? albumMap : NO_ALBUMS, refresh };
}
