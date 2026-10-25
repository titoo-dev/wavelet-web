"use client";

import { useEffect, useState } from "react";
import { useAppStore } from "@/stores/useAppStore";
import { useAuthStore } from "@/stores/useAuthStore";
import { fetchData } from "@/utils/api";
import { useShareStore } from "@/stores/useShareStore";

export function useInitApp() {
	const [initialized, setInitialized] = useState(false);
	const setDeezerAvailable = useAppStore((s) => s.setDeezerAvailable);
	const { setUser, setDeezerUser, setLoading } = useAuthStore();

	useEffect(() => {
		if (initialized) return;

		async function init() {
			try {
				const data = await fetchData("auth/connect");

				if (data.deezerAvailable) {
					setDeezerAvailable(data.deezerAvailable);
				}

				// Better-auth user (Google identity)
				if (data.user) {
					setUser(data.user);
					// Load shared tracks for the authenticated user
					useShareStore.getState().load();
				}

				// Deezer connection (auto-restored from stored ARL)
				if (data.deezerUser) {
					setDeezerUser(data.deezerUser);
				}
			} catch (e) {
				console.error("Failed to connect:", e);
			}
			setLoading(false);
			setInitialized(true);
		}

		init();
		// The setters are store actions: stable for the app's lifetime.
	}, [initialized, setDeezerAvailable, setUser, setDeezerUser, setLoading]);
}
