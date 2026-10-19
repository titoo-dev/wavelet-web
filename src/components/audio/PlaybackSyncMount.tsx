"use client";

import { useEffect } from "react";
import { toast } from "sonner";
import { createConvexSyncClient } from "@/lib/playback-sync/convex-client";
import { claimDeviceId, deviceName, watchActivation } from "@/lib/playback-sync/device";
import { setPlaybackSync } from "@/lib/playback-sync/instance";
import { PlaybackSync } from "@/lib/playback-sync/sync";
import { useAuthStore } from "@/stores/useAuthStore";

const CONVEX_URL = process.env.NEXT_PUBLIC_CONVEX_URL;

/**
 * Makes this signed-in tab a Device of the user's Playback Session (CONTEXT.md). Mounted in the
 * main layout only: the public Share Player is never a Device. Without NEXT_PUBLIC_CONVEX_URL
 * the player stays on its own, as before.
 */
export function PlaybackSyncMount() {
	const userId = useAuthStore((s) => s.user?.id ?? null);

	useEffect(() => {
		if (!userId || !CONVEX_URL) return;
		let disposed = false;
		let cleanup = () => {};
		void claimDeviceId().then(({ id, release }) => {
			if (disposed) return release();
			const client = createConvexSyncClient(CONVEX_URL);
			let sync: PlaybackSync | null = null;
			const activation = watchActivation(() => sync?.activationChanged());
			sync = new PlaybackSync({
				client,
				deviceId: id,
				deviceName: deviceName(),
				isActivated: activation.isActivated,
				onUnresponsive: (name) => toast.error(`${name} is not responding`),
			});
			setPlaybackSync(sync);
			sync.start();
			const onPageHide = () => client.leaveOnUnload(id);
			window.addEventListener("pagehide", onPageHide);
			cleanup = () => {
				window.removeEventListener("pagehide", onPageHide);
				activation.dispose();
				setPlaybackSync(null);
				sync?.stop();
				release();
			};
		});
		return () => {
			disposed = true;
			cleanup();
		};
	}, [userId]);

	return null;
}
