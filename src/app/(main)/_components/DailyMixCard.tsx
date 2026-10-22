"use client";

import { useMemo, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ChevronDown, RefreshCw, Shuffle, Sparkles } from "lucide-react";
import { TrackRow, type TrackRowTrack } from "@/components/tracks/TrackRow";
import { Art, BigPlayButton, CoverTheme, SectionTitle, entrance } from "@/components/expressive";
import { Skeleton } from "@/components/ui/skeleton";
import { usePlayerStore, type PlayerTrack } from "@/stores/usePlayerStore";
import { useDailyMix } from "@/hooks/useDailyMix";
import { formatTotal } from "@/lib/collection-page";
import { cn } from "@/lib/utils";
import type { DailyMix } from "@/lib/daily-mix";

/** How tracks played from the mix are tagged in the queue and the listening log. */
export const DAILY_MIX_SOURCE = "daily-mix";

/** "Daft Punk, Justice and Kavinsky". */
export function artistLine(artists: string[]): string {
	if (artists.length <= 1) return artists[0] ?? "";
	return `${artists.slice(0, -1).join(", ")} and ${artists.at(-1)}`;
}

function subtitleOf(mix: DailyMix): string {
	if (mix.basedOn === "flow") return "From your Deezer Flow, while we learn your taste";
	return mix.artists.length ? `${artistLine(mix.artists)}, and more like them` : "Tracks you love, and more like them";
}

/** Home: the Daily Mix of the day — play it, shuffle it, or open its tracks. Hidden while there is none. */
export function DailyMixCard() {
	const { state, refresh } = useDailyMix();
	if (state.status === "error") return null;
	if (state.status === "loading") return <DailyMixSkeleton />;
	if (state.mix.tracks.length === 0) return null;
	return <MixCard mix={state.mix} onRefresh={refresh} />;
}

function MixCard({ mix, onRefresh }: { mix: DailyMix; onRefresh: () => void }) {
	const [open, setOpen] = useState(false);
	const playQueue = usePlayerStore((s) => s.playQueue);
	const shuffleOn = usePlayerStore((s) => s.shuffle);
	const toggleShuffle = usePlayerStore((s) => s.toggleShuffle);

	const rows: TrackRowTrack[] = useMemo(
		() => mix.tracks.map((t) => ({ ...t, bitrateLabel: null, source: DAILY_MIX_SOURCE })),
		[mix.tracks]
	);
	const queue: PlayerTrack[] = useMemo(() => mix.tracks.map((t) => ({ ...t, source: DAILY_MIX_SOURCE })), [mix.tracks]);
	const covers = useMemo(() => [...new Set(mix.tracks.map((t) => t.cover).filter((c): c is string => !!c))], [mix.tracks]);
	const total = mix.tracks.reduce((s, t) => s + (t.duration ?? 0), 0);

	const start = (shuffle: boolean) => {
		if (shuffle !== shuffleOn) toggleShuffle();
		playQueue(queue, shuffle ? Math.floor(Math.random() * queue.length) : 0);
	};

	return (
		<section aria-label="Daily Mix">
			<SectionTitle eyebrow="Made for you" title="Your Daily Mix" />
			<CoverTheme src={covers[0]}>
				<motion.div
					{...entrance(1)}
					className="overflow-hidden rounded-m3-xl bg-[linear-gradient(135deg,var(--m3-primary-container),var(--m3-tertiary-container))] text-on-primary-container shadow-[0_12px_32px_-14px_color-mix(in_oklch,var(--m3-primary)_55%,transparent)]"
				>
					<div className="flex flex-col gap-5 p-4 sm:flex-row sm:items-center sm:p-5">
						<Art
							covers={covers.length >= 4 ? covers : undefined}
							src={covers[0]}
							size={320}
							rounded="rounded-m3-lg"
							className="aspect-square w-full max-w-[200px] shrink-0 shadow-[0_8px_20px_-6px_rgb(0_0_0/0.35)] sm:w-40"
						/>
						<div className="min-w-0 flex-1">
							<p className="type-eyebrow flex items-center gap-1.5 text-primary">
								<Sparkles className="size-3.5" />
								Today · {mix.tracks.length} tracks{total ? ` · ${formatTotal(total)}` : ""}
							</p>
							<h3 className="mt-1.5 text-2xl font-bold tracking-[-0.02em] sm:text-3xl">Daily Mix</h3>
							<p className="mt-1 line-clamp-2 text-sm text-on-primary-container/80">{subtitleOf(mix)}</p>
							<div className="mt-4 flex flex-wrap items-center gap-2">
								<BigPlayButton trackIds={queue.map((t) => t.trackId)} onPlay={() => start(false)} label="Play Daily Mix" size={52} />
								<motion.button
									type="button"
									whileTap={{ scale: 0.94 }}
									onClick={() => start(true)}
									className="inline-flex h-11 items-center gap-2 rounded-full bg-surface-highest/70 px-4 text-sm font-semibold transition-colors hover:bg-surface-highest"
								>
									<Shuffle className="size-[18px]" />
									Shuffle
								</motion.button>
								<motion.button
									type="button"
									whileTap={{ scale: 0.94 }}
									onClick={() => setOpen((o) => !o)}
									aria-expanded={open}
									className="inline-flex h-11 items-center gap-2 rounded-full bg-surface-highest/70 px-4 text-sm font-semibold transition-colors hover:bg-surface-highest"
								>
									<ChevronDown className={cn("size-[18px] transition-transform duration-300", open && "rotate-180")} />
									{open ? "Hide tracks" : "Tracks"}
								</motion.button>
								<motion.button
									type="button"
									whileTap={{ scale: 0.9, rotate: 90 }}
									onClick={onRefresh}
									aria-label="New mix"
									title="New mix"
									className="inline-flex size-11 items-center justify-center rounded-full text-on-primary-container/80 transition-colors hover:bg-surface-highest/70 hover:text-on-primary-container"
								>
									<RefreshCw className="size-[18px]" />
								</motion.button>
							</div>
						</div>
					</div>
					<AnimatePresence initial={false}>
						{open && (
							<motion.div
								key="tracks"
								initial={{ height: 0, opacity: 0 }}
								animate={{ height: "auto", opacity: 1 }}
								exit={{ height: 0, opacity: 0 }}
								transition={{ duration: 0.35, ease: [0.2, 0, 0, 1] }}
								className="overflow-hidden"
							>
								<div className="mx-2 mb-2 space-y-0.5 rounded-m3-lg bg-background/70 p-2 text-foreground backdrop-blur-sm">
									{rows.map((t, i) => (
										<TrackRow key={t.trackId} track={t} trackNumber={i + 1} showBitrate={false} queue={rows} />
									))}
								</div>
							</motion.div>
						)}
					</AnimatePresence>
				</motion.div>
			</CoverTheme>
		</section>
	);
}

function DailyMixSkeleton() {
	return (
		<section aria-label="Daily Mix" aria-busy="true">
			<SectionTitle eyebrow="Made for you" title="Your Daily Mix" />
			<div className="flex flex-col gap-5 rounded-m3-xl bg-surface-container p-4 sm:flex-row sm:items-center sm:p-5">
				<Skeleton className="aspect-square w-full max-w-[200px] rounded-m3-lg sm:w-40" />
				<div className="flex-1 space-y-3">
					<Skeleton className="h-3 w-40 rounded-full" />
					<Skeleton className="h-8 w-48 rounded-full" />
					<Skeleton className="h-4 w-64 max-w-full rounded-full" />
					<div className="flex gap-2 pt-1">
						<Skeleton className="size-[60px] rounded-full" />
						<Skeleton className="h-11 w-28 rounded-full" />
					</div>
				</div>
			</div>
		</section>
	);
}
