"use client";

import { useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ChevronRight, CloudDownload, Info, LogOut, Monitor, Moon, Sparkles, Sun, TriangleAlert, Volume2, Waves } from "lucide-react";
import { AudioCacheManager } from "@/components/audio/AudioCacheManager";
import { usePlayerStore } from "@/stores/usePlayerStore";
import { useAuthStore } from "@/stores/useAuthStore";
import { useErrorStore } from "@/stores/useErrorStore";
import { useUserPreferences } from "@/hooks/useUserPreferences";
import { useDiscover } from "@/hooks/useDiscover";
import { signOutEverywhere } from "@/lib/sign-out";
import { toast } from "sonner";
import { applyThemePreference, readThemePreference, type ThemePreference } from "@/lib/theme";
import { fetchData } from "@/utils/api";
import { SlidingSegments, entrance, swap } from "@/components/expressive";
import { Skeleton } from "@/components/ui/skeleton";
import { SettingsSection, SettingsSwitchTile, SettingsTile, StatusPill } from "./_components/SettingsTiles";
import { CrossfadeTile, DeezerAccountTile, QualityTile } from "./_components/PlaybackTiles";
import { ShareLinksTile } from "./_components/ShareLinksTile";
import { GuestHero, ProfileHero } from "./_components/SettingsHero";

interface LibraryItem {
	coverUrl: string | null;
}

/** Liked / album counts and covers for the profile hero (signed in only). */
function useLibrarySummary(enabled: boolean) {
	const [state, setState] = useState<{ liked: number | null; albums: number | null; covers: string[] }>({ liked: null, albums: null, covers: [] });
	useEffect(() => {
		if (!enabled) return;
		let live = true;
		Promise.all([
			fetchData("library/tracks", { limit: "500" }).catch(() => null) as Promise<{ items: LibraryItem[] } | null>,
			fetchData("library/albums").catch(() => null) as Promise<{ items: LibraryItem[] } | null>,
		]).then(([tracks, albums]) => {
			if (!live) return;
			const covers = [...new Set([...(albums?.items ?? []), ...(tracks?.items ?? []).slice(0, 40)].map((i) => i.coverUrl).filter((c): c is string => !!c))].slice(0, 30);
			setState({ liked: tracks?.items?.length ?? null, albums: albums?.items?.length ?? null, covers });
		});
		return () => {
			live = false;
		};
	}, [enabled]);
	return state;
}

/** The stored theme preference (read after mount so SSR and hydration agree). */
function useThemePreference() {
	const [pref, setPref] = useState<ThemePreference>("system");
	useEffect(() => {
		// eslint-disable-next-line react-hooks/set-state-in-effect -- localStorage is client-only
		setPref(readThemePreference());
	}, []);
	return [
		pref,
		(p: ThemePreference) => {
			setPref(p);
			applyThemePreference(p);
		},
	] as const;
}

function SettingsSkeleton() {
	return (
		<div className="space-y-6">
			<Skeleton className="h-[260px] rounded-[28px]" />
			<div className="grid gap-x-6 lg:grid-cols-2">
				{[3, 2].map((n, c) => (
					<div key={c} className="space-y-[2px] pt-12">
						{Array.from({ length: n }, (_, i) => (
							<Skeleton key={i} className={i === 0 ? "h-[72px] rounded-b-md rounded-t-[24px]" : i === n - 1 ? "h-[72px] rounded-b-[24px] rounded-t-md" : "h-[72px] rounded-md"} />
						))}
					</div>
				))}
			</div>
		</div>
	);
}

export default function SettingsPage() {
	const normalizationEnabled = usePlayerStore((s) => s.normalizationEnabled);
	const toggleNormalization = usePlayerStore((s) => s.toggleNormalization);
	const crossfadeDuration = usePlayerStore((s) => s.crossfadeDuration);
	const setCrossfadeDuration = usePlayerStore((s) => s.setCrossfadeDuration);
	const gapless = usePlayerStore((s) => s.gapless);
	const toggleGapless = usePlayerStore((s) => s.toggleGapless);
	const autoplay = usePlayerStore((s) => s.autoplay);
	const toggleAutoplay = usePlayerStore((s) => s.toggleAutoplay);

	const user = useAuthStore((s) => s.user);
	const deezerUser = useAuthStore((s) => s.deezerUser);
	const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
	const isLoading = useAuthStore((s) => s.isLoading);
	const errorCount = useErrorStore((s) => s.errors.length);
	const { prefs, updatePrefs } = useUserPreferences();
	const preCacheSaved = !!prefs.preCacheSaved;
	const [theme, setTheme] = useThemePreference();
	const library = useLibrarySummary(isAuthenticated);
	const { showcase } = useDiscover();

	const signedIn = isAuthenticated && !!user;
	const avatarUrls = [deezerUser?.picture ? `https://e-cdns-images.dzcdn.net/images/user/${deezerUser.picture}/250x250-000000-80-0-0.jpg` : null, user?.image].filter((u): u is string => !!u);
	const heroCovers = useMemo(() => (library.covers.length >= 8 ? library.covers : [...library.covers, ...showcase].slice(0, 30)), [library.covers, showcase]);

	const signOut = async () => {
		if (!(await signOutEverywhere())) toast.error("Couldn't sign out", { description: "Check your connection and try again." });
	};

	let section = 1;

	return (
		<div className="mx-auto max-w-5xl pb-6 pt-2">
			<motion.header {...entrance(0)} className="mb-5 px-1 sm:mb-6">
				<p className="type-eyebrow text-primary">Preferences</p>
				<h1 className="type-display mt-1 text-4xl text-foreground sm:text-5xl">Settings</h1>
			</motion.header>

			<AnimatePresence mode="wait" initial={false}>
				{isLoading ? (
					<motion.div key="loading" variants={swap} initial="initial" animate="animate" exit="exit">
						<SettingsSkeleton />
					</motion.div>
				) : (
					<motion.div key={signedIn ? "user" : "guest"} variants={swap} initial="initial" animate="animate" exit="exit">
						{signedIn ? (
							<ProfileHero
								name={user.name || deezerUser?.name || "You"}
								email={user.email}
								avatarUrls={avatarUrls}
								deezer={deezerUser ? (deezerUser.can_stream_lossless ? "lossless" : "linked") : null}
								liked={library.liked}
								albums={library.albums}
								covers={heroCovers}
								onSignOut={signOut}
							/>
						) : (
							<GuestHero covers={showcase} />
						)}

						<div className="grid items-start gap-x-6 lg:grid-cols-2">
							<div className="min-w-0">
								{signedIn && (
									<SettingsSection title="Account" index={section++}>
										<SettingsTile
											icon={GoogleGlyph}
											title="Google"
											subtitle={user.email ? `Linked to ${user.email}` : "Signed in with Google"}
											tone="secondary"
											trailing={<StatusPill label="Connected" tone="secondary" />}
										/>
										<DeezerAccountTile />
									</SettingsSection>
								)}

								<SettingsSection title="Playback" index={section++}>
									{signedIn && <QualityTile />}
									<SettingsSwitchTile
										icon={Volume2}
										title="Volume normalization"
										subtitle="Evens out loudness so every track plays at the same level."
										checked={normalizationEnabled}
										onCheckedChange={() => toggleNormalization()}
									/>
									{signedIn && (
										<SettingsSwitchTile
											icon={CloudDownload}
											title="Pre-cache saved music"
											subtitle="Prepare tracks and albums you save so they start instantly."
											checked={preCacheSaved}
											onCheckedChange={(v) => updatePrefs({ preCacheSaved: v })}
										/>
									)}
									<CrossfadeTile seconds={crossfadeDuration} onChange={setCrossfadeDuration} />
								<SettingsSwitchTile
									icon={Waves}
									title="Gapless playback"
									subtitle={
										gapless && crossfadeDuration > 0
											? "Paused while crossfade is on."
											: "No silence between the tracks of a live album or a mix (stored MP3s)."
									}
									checked={gapless}
									onCheckedChange={() => toggleGapless()}
								/>
									{signedIn && (
										<SettingsSwitchTile
											icon={Sparkles}
											title="Autoplay"
											subtitle="When your queue ends, keep playing similar tracks."
											checked={autoplay}
											onCheckedChange={() => toggleAutoplay()}
										/>
									)}
									<AudioCacheManager />
								</SettingsSection>
							</div>

							<div className="min-w-0">
								<SettingsSection title="Appearance" index={section++}>
									<div className="p-3">
										<SlidingSegments
											id="theme"
											value={theme}
											onChange={setTheme}
											items={[
												{ value: "system", label: "System", icon: Monitor },
												{ value: "light", label: "Light", icon: Sun },
												{ value: "dark", label: "Dark", icon: Moon },
											]}
										/>
									</div>
								</SettingsSection>

								{signedIn && (
									<SettingsSection title="Sharing" index={section++}>
										<ShareLinksTile />
									</SettingsSection>
								)}

								<SettingsSection title="About" index={section++}>
									<SettingsTile icon={Info} title="About wavelet" subtitle="Version, server and licenses" tone="secondary" href="/about" />
									<SettingsTile
										icon={TriangleAlert}
										title="Download errors"
										subtitle={errorCount ? `${errorCount} failed download${errorCount === 1 ? "" : "s"}` : "Nothing failed. All clean."}
										tone={errorCount ? "error" : "muted"}
										href="/errors"
										trailing={
											<>
												{errorCount > 0 && <StatusPill label={errorCount} tone="error" />}
												<ChevronRight className="size-5 text-muted-foreground" />
											</>
										}
									/>
									{signedIn && <SettingsTile icon={LogOut} title="Sign out" destructive onClick={signOut} trailing={null} />}
								</SettingsSection>
							</div>
						</div>
					</motion.div>
				)}
			</AnimatePresence>
		</div>
	);
}

/** Monochrome Google "G" sized like a lucide icon (inherits the badge colour). */
function GoogleGlyph({ className }: { className?: string }) {
	return (
		<svg viewBox="0 0 24 24" aria-hidden className={className} fill="currentColor">
			<path d="M21.35 11.1H12v2.98h5.35c-.23 1.4-1.66 4.1-5.35 4.1-3.22 0-5.85-2.67-5.85-5.96S8.78 6.26 12 6.26c1.83 0 3.06.78 3.76 1.45l2.57-2.47C16.68 3.7 14.55 2.75 12 2.75 6.9 2.75 2.75 6.9 2.75 12s4.15 9.25 9.25 9.25c5.34 0 8.88-3.75 8.88-9.04 0-.61-.07-1.07-.15-1.11z" />
		</svg>
	);
}
