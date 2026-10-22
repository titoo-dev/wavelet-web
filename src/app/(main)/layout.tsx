"use client";

import { Suspense } from "react";
import { MotionConfig } from "motion/react";
import { useInitApp } from "@/hooks/useInitApp";
import { useKeyboardShortcuts } from "@/hooks/useKeyboardShortcuts";
import { useOverlayHistory } from "@/hooks/useOverlayHistory";
import { useAutoplay } from "@/hooks/useAutoplay";
import { AppHeader } from "@/components/layout/AppHeader";
import { BehindOverlays } from "@/components/layout/BehindOverlays";
import { NavProgress } from "@/components/layout/NavProgress";
import { CommandPalette } from "@/components/command/CommandPalette";
import { AudioPreview } from "@/components/audio/AudioPreview";
import { MiniPlayer } from "@/components/audio/MiniPlayer";
import { AudioEngine } from "@/components/audio/AudioEngine";
import { AudioEngineErrorBoundary } from "@/components/audio/AudioEngineErrorBoundary";
import { PlaybackSyncMount } from "@/components/audio/PlaybackSyncMount";
import { Player } from "@/components/audio/Player";
import { FullscreenPlayer } from "@/components/audio/FullscreenPlayer";
import { QueuePanel } from "@/components/audio/QueuePanel";
import { TrackAnnouncer } from "@/components/audio/TrackAnnouncer";
import { Toaster } from "@/components/ui/sonner";
import { LyricsPanel } from "@/components/audio/LyricsPanel";
import { LyricsImmersive } from "@/components/audio/LyricsImmersive";
import { TrackActionSheet } from "@/components/tracks/TrackActionSheet";
import { ImportSpotifyDialog } from "@/components/playlists/ImportSpotifyDialog";

export default function MainLayout({ children }: { children: React.ReactNode }) {
	useInitApp();
	useKeyboardShortcuts();
	useOverlayHistory();
	useAutoplay();

	return (
		<MotionConfig reducedMotion="user">
			<div className="relative min-h-dvh bg-background">
				<Suspense fallback={null}>
					<NavProgress />
				</Suspense>
				{/* Inert under Now Playing / immersive lyrics, so the focus stays in them. */}
				<BehindOverlays>
					<AppHeader />

					<main className="mx-auto w-full min-w-0 max-w-6xl px-4 pt-6 pb-app-chrome sm:px-6 sm:pt-8 lg:px-8">{children}</main>
				</BehindOverlays>

				{/* ─── Search + downloads ─── */}
				<CommandPalette />

				{/* ─── Audio ─── */}
				<AudioPreview />
				<AudioEngineErrorBoundary>
					<AudioEngine />
				</AudioEngineErrorBoundary>
				<PlaybackSyncMount />
				<BehindOverlays>
					<MiniPlayer />
					<Player />
				</BehindOverlays>
				<LyricsPanel />
				<LyricsImmersive />
				<FullscreenPlayer />
				<QueuePanel />
				<TrackAnnouncer />
				<TrackActionSheet />

				{/* ─── Spotify import (keeps running when closed) ─── */}
				<ImportSpotifyDialog />
				<Toaster />
			</div>
		</MotionConfig>
	);
}
