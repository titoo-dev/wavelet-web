import { defineConfig } from "vitest/config";
import { fileURLToPath } from "url";
import path from "path";

const dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
	resolve: {
		alias: {
			"@": path.resolve(dirname, "./src"),
		},
	},
	test: {
		globals: true,
		// jsdom by default — store tests need it (Zustand persist + localStorage).
		// API/route tests run fine under jsdom too since they never touch the DOM.
		// To opt back to node for a specific file, add `// @vitest-environment node`
		// at the top of that test file.
		environment: "jsdom",
		setupFiles: ["./src/test/setup.ts"],
		// convex/ tests run on convex-test (mock backend) under `// @vitest-environment edge-runtime`.
		include: ["src/**/*.{test,spec}.{ts,tsx}", "convex/**/*.test.ts"],
		server: { deps: { inline: ["convex-test"] } },
		exclude: ["node_modules", ".next", "dist"],
		clearMocks: true,
		restoreMocks: true,
		coverage: {
			provider: "v8",
			reporter: ["text", "html", "json-summary", "lcov"],
			reportsDirectory: "./coverage",
			// Scope coverage to the files we have explicitly locked in. Adding
			// new untested files here will drop the average and fail the gate.
			// As you add tests for new modules, append them here.
			include: [
				"convex/{lib,devices,playback,commands,presence}.ts",
				"src/stores/usePlayerStore.ts",
				"src/lib/playback-sync/{device,execute,remote,sync,track,useSyncStore}.ts",
				"src/components/audio/DevicePicker.tsx",
				"src/stores/usePreviewStore.ts",
				"src/stores/useTrackActionStore.ts",
				"src/lib/library.ts",
				"src/app/api/v1/_lib/helpers.ts",
				"src/app/api/v1/stream/**",
				"src/app/api/v1/stream-progressive/**",
				"src/app/api/v1/stream-url/**",
				"src/app/api/v1/library/**",
				"src/app/api/v1/recent-plays/**",
				"src/app/api/v1/preferences/**",
				"src/stores/useDownloadStore.ts",
				"src/stores/useCommandStore.ts",
				"src/lib/download.ts",
				"src/lib/theme.ts",
				"src/hooks/useKeyboardShortcuts.ts",
				"src/lib/hotkeys.ts",
				"src/components/layout/BehindOverlays.tsx",
				"src/components/command/CommandPalette.tsx",
				"src/components/audio/SeekBar.tsx",
				"src/lib/seek.ts",
				"src/lib/db-url.ts",
				"src/components/audio/WaveSeek.tsx",
				"src/lib/wave.ts",
				"src/lib/spectrum.ts",
				"src/lib/stream-failure.ts",
				"src/lib/logo.ts",
				"src/lib/object-stream.ts",
				"src/lib/wavelet/storage/objects.ts",
				"src/lib/wavelet/storage/r2.ts",
				"src/lib/wavelet/storage/R2StorageProvider.ts",
				"src/lib/wavelet/tee-pump.ts",
				"src/lib/auth.ts",
				"src/lib/cover-palette.ts",
				"src/lib/discover.ts",
				"src/lib/lyrics/**",
				"src/app/api/v1/lyrics/**",
				"src/stores/useLyricsStore.ts",
				"src/lib/entity-links.ts",
				"src/lib/overlay-history.ts",
				"src/hooks/useOverlayHistory.ts",
				"src/lib/login-redirect.ts",
				"src/lib/sign-out.ts",
				"src/lib/trailing-send.ts",
				"src/components/collection/useTracklist.ts",
				"src/lib/nav-progress.ts",
				"src/components/layout/NavProgress.tsx",
				"src/components/layout/HistoryNav.tsx",
				"src/lib/playlist-summaries.ts",
				"src/components/links/EntityLink.tsx",
				"src/components/audio/leave-player.ts",
				"src/lib/spotify/import.ts",
				"src/lib/spotify/import-run.ts",
				"src/lib/spotify/link-input.ts",
				"src/components/playlists/SpotifyLinksField.tsx",
				"src/stores/useSpotifyImportStore.ts",
				"src/app/api/v1/playlists/import/spotify/{playlist,match,save}/route.ts",
				"src/components/motion/WavyProgress.tsx",
				// Engine audit (2026-10): Deezer decryption + progressive pipeline + storage
				"src/lib/wavelet/decryption.ts",
				"src/lib/wavelet/stripe.ts",
				"src/lib/wavelet/stream-errors.ts",
				"src/lib/wavelet/progressive-stream.ts",
				"src/lib/wavelet/storage/{cached-copy,persist-lease,gc,key-repair}.ts",
				"src/lib/wavelet/cache/{metadata-cache,rate-limit}.ts",
				"src/app/api/v1/shares/[shareId]/stream/**",
				"src/app/api/v1/shares/route.ts",
				"src/app/api/v1/shares/[shareId]/route.ts",
				"src/lib/share-meta.ts",
				"src/stores/useShareStore.ts",
				"src/app/api/v1/internal/**",
				"src/app/api/v1/stream-warm/**",
				// Engine audit: Deezer client hardening + auth/settings security
				"src/lib/deezer/{http,public-user}.ts",
				"src/lib/log-safe.ts",
				"src/lib/secret-box.ts",
				"src/lib/deezer-session.ts",
				"src/lib/wavelet/config-store/PostgresConfigStore.ts",
				"src/app/api/v1/auth/{change-account,login-arl,login-email}/route.ts",
				"src/app/api/v1/settings/**",
				// Engine audit: web player engine, prefetch and audio cache
				"src/components/audio/engine/*.ts",
				"src/lib/audio-cache.ts",
				"src/lib/prefetch-budget.ts",
				"src/utils/audio-context.ts",
				"src/utils/adjust-volume.ts",
				"src/hooks/usePrefetch.ts",
			],
			exclude: [
				"**/*.test.{ts,tsx}",
				"**/*.spec.{ts,tsx}",
				"src/test/**",
			],
			// Global thresholds — set just below the current baseline so a real
			// regression (deleted tests, dead code paths) trips CI, but a small
			// refactor doesn't have to chase the last percent. Tighten as the
			// suite grows. Per-file enforcement is intentionally off because
			// `library.ts` has known-untested helpers (playlist/share helpers
			// outside the user-library scope locked in this pass).
			thresholds: {
				lines: 90,
				branches: 85,
				functions: 90,
				statements: 90,
			},
		},
	},
});
