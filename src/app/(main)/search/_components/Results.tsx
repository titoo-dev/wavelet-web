"use client";

import { useEffect, useMemo, useRef } from "react";
import Link from "next/link";
import { AnimatePresence, motion } from "motion/react";
import { toast } from "sonner";
import { ArrowRight, RotateCw, SearchX } from "lucide-react";
import { TrackRow, trackFromDeezerRaw, type TrackRowTrack } from "@/components/tracks/TrackRow";
import { MediaCard, CardGrid } from "@/components/cards/MediaCard";
import { DownloadGlyph, Equalizer, PlayPauseIcon, Spinner } from "@/components/motion/icons";
import { Skeleton } from "@/components/ui/skeleton";
import { Art, CardCarousel, CoverTheme, Medallion, SavedBadge, SectionTitle, entrance, swap } from "@/components/expressive";
import { usePlayerStore, type PlayerTrack } from "@/stores/usePlayerStore";
import { useDownloadStore } from "@/stores/useDownloadStore";
import { useAuthStore } from "@/stores/useAuthStore";
import { useCommandStore } from "@/stores/useCommandStore";
import { cn } from "@/lib/utils";
import { ArtistLink } from "@/components/links/EntityLink";
import {
	TABS,
	albumProps,
	artistProps,
	artistSubtitle,
	isMainEmpty,
	pickTopResult,
	playlistProps,
	playlistSubtitle,
	trackCover,
	type SearchTab,
	type TopPick,
	type AlbumCard,
} from "../_lib/search-model";
import { useTypedSearch } from "../_lib/useSearch";
import { KindPill } from "./bits";
import { VirtualRows } from "@/components/virtual/VirtualRows";
import type { GwResults } from "@/lib/deezer/gw";

const ARTIST_ITEM = "w-[128px] sm:w-[150px] lg:w-[164px]";

function toPlayer(t: TrackRowTrack, cover?: string | null): PlayerTrack {
	return { trackId: t.trackId, title: t.title, artist: t.artist, artistId: t.artistId ?? null, album: t.album ?? null, albumId: t.albumId ?? null, cover: cover ?? t.cover, duration: t.duration ?? null };
}

/** "Artist · 2001" under an album card, the artist linking to its page. */
function albumByline(a: AlbumCard) {
	if (!a.artist) return a.year ?? undefined;
	return (
		<>
			<ArtistLink id={a.artistId} name={a.artist} className="transition-colors hover:text-foreground" />
			{a.year && ` · ${a.year}`}
		</>
	);
}

function Retry({ onRetry, message }: { onRetry: () => void; message?: string | null }) {
	return (
		<Medallion
			icon={SearchX}
			title="Search failed"
			message={message || "Deezer didn’t answer. Try again in a moment."}
			action={
				<motion.button type="button" whileTap={{ scale: 0.95 }} onClick={onRetry} className="inline-flex h-11 items-center gap-2 rounded-full bg-secondary px-5 text-sm font-semibold text-secondary-foreground">
					<RotateCw className="size-[18px]" />
					Retry
				</motion.button>
			}
		/>
	);
}

// ─── All ────────────────────────────────────────────────────────────────────

export function AllResults({
	term,
	main,
	loading,
	error,
	onRetry,
	onTab,
	albumMap,
}: {
	term: string;
	main: GwResults;
	loading: boolean;
	error: string | null;
	onRetry: () => void;
	onTab: (t: SearchTab) => void;
	albumMap: Map<string, string>;
}) {
	const allTracks = useMemo<TrackRowTrack[]>(() => (main?.TRACK?.data ?? []).map((t: GwResults) => trackFromDeezerRaw(t)), [main]);

	return (
		<AnimatePresence mode="wait" initial={false}>
			{loading ? (
				<motion.div key="loading" variants={swap} initial="initial" animate="animate" exit="exit">
					<AllSkeleton />
				</motion.div>
			) : error || !main ? (
				<motion.div key="error" variants={swap} initial="initial" animate="animate" exit="exit">
					<Retry onRetry={onRetry} message={error} />
				</motion.div>
			) : isMainEmpty(main) ? (
				<motion.div key="empty" variants={swap} initial="initial" animate="animate" exit="exit">
					<Medallion icon={SearchX} title="No results" message={`Nothing matched “${term}”.`} />
				</motion.div>
			) : (
				<motion.div key={`data-${term}`} variants={swap} initial="initial" animate="animate" exit="exit">
					<AllData term={term} main={main} tracks={allTracks} onTab={onTab} albumMap={albumMap} />
				</motion.div>
			)}
		</AnimatePresence>
	);
}

function AllData({ term, main, tracks, onTab, albumMap }: { term: string; main: GwResults; tracks: TrackRowTrack[]; onTab: (t: SearchTab) => void; albumMap: Map<string, string> }) {
	const pick = pickTopResult(main, term);
	const artists = (main?.ARTIST?.data ?? []).slice(0, 12).map(artistProps);
	const albums = (main?.ALBUM?.data ?? []).slice(0, 12).map(albumProps);
	const playlists = (main?.PLAYLIST?.data ?? []).slice(0, 12).map(playlistProps);
	const total = (k: string) => main?.[k]?.total ?? main?.[k]?.data?.length ?? null;

	return (
		<div>
			<div className={cn("grid gap-x-8 pt-2", pick && tracks.length > 0 && "lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]")}>
				{pick && (
					<div className="flex flex-col">
						<h2 className="sr-only">Top result</h2>
						<TopResult pick={pick} queue={tracks} />
					</div>
				)}
				{tracks.length > 0 && (
					<section className="min-w-0">
						<SectionTitle title="Songs" count={total("TRACK")} onAction={() => onTab("track")} className={cn(pick && "lg:mt-0")} />
						<div className="-mx-2">
							{tracks.slice(0, 5).map((t, i) => (
								<motion.div key={t.trackId} {...entrance(i + 1, 10)}>
									<TrackRow track={t} queue={tracks} showBitrate={false} />
								</motion.div>
							))}
						</div>
					</section>
				)}
			</div>

			{artists.length > 0 && (
				<section>
					<SectionTitle title="Artists" count={total("ARTIST")} onAction={() => onTab("artist")} />
					<CardCarousel itemClassName={ARTIST_ITEM}>
						{artists.map((a: ReturnType<typeof artistProps>, i: number) => (
							<MediaCard key={a.id} index={i} href={`/artist?id=${a.id}`} title={a.name} subtitle={artistSubtitle(a)} cover={a.picture} round />
						))}
					</CardCarousel>
				</section>
			)}

			{albums.length > 0 && (
				<section>
					<SectionTitle title="Albums" count={total("ALBUM")} onAction={() => onTab("album")} />
					<CardCarousel>
						{albums.map((a: ReturnType<typeof albumProps>, i: number) => (
							<MediaCard
								key={a.id}
								index={i}
								href={`/album?id=${a.id}`}
								title={a.title}
								subtitle={albumByline(a)}
								cover={a.cover}
								collection={{ type: "album", id: a.id }}
								badge={albumMap.has(a.id) ? <SavedBadge /> : undefined}
							/>
						))}
					</CardCarousel>
				</section>
			)}

			{playlists.length > 0 && (
				<section>
					<SectionTitle title="Playlists" count={total("PLAYLIST")} onAction={() => onTab("playlist")} />
					<CardCarousel>
						{playlists.map((p: ReturnType<typeof playlistProps>, i: number) => (
							<MediaCard key={p.id} index={i} href={`/playlist?id=${p.id}`} title={p.title} subtitle={playlistSubtitle(p)} cover={p.picture} collection={{ type: "playlist", id: p.id }} />
						))}
					</CardCarousel>
				</section>
			)}
		</div>
	);
}

/**
 * Hero "Top result" card, themed from its artwork: an exact artist match,
 * else the first track (or album), with a one-tap play.
 */
function TopResult({ pick, queue }: { pick: NonNullable<TopPick>; queue: TrackRowTrack[] }) {
	const current = usePlayerStore((s) => s.currentTrack);
	const isPlaying = usePlayerStore((s) => s.isPlaying);
	const play = usePlayerStore((s) => s.play);
	const toggle = usePlayerStore((s) => s.toggle);

	const view = useMemo(() => {
		if (pick.kind === "artist") {
			const a = artistProps(pick.raw);
			return { image: a.picture, title: a.name, kind: "Artist", subtitle: a.fans != null ? artistSubtitle(a) : null, artist: null, circle: true, href: `/artist?id=${a.id}`, track: null };
		}
		if (pick.kind === "album") {
			const a = albumProps(pick.raw);
			return { image: a.cover, title: a.title, kind: "Album", subtitle: a.artist, artist: a.artist ? { id: a.artistId, name: a.artist } : null, circle: false, href: `/album?id=${a.id}`, track: null };
		}
		const t = trackFromDeezerRaw(pick.raw);
		return { image: trackCover(pick.raw), title: t.title, kind: "Song", subtitle: t.artist, artist: t.artist ? { id: t.artistId, name: t.artist } : null, circle: false, href: null, track: t };
	}, [pick]);

	const isCurrent = !!view.track && current?.trackId === view.track.trackId;
	const playing = isCurrent && isPlaying;
	const activate = () => {
		if (!view.track) return;
		if (isCurrent) return toggle();
		play(
			toPlayer(view.track, view.image),
			queue.map((q) => (q.trackId === view.track!.trackId ? toPlayer(q, view.image) : toPlayer(q)))
		);
	};

	return (
		<CoverTheme src={view.image} className="flex-1">
			<motion.div
				{...entrance(0)}
				whileTap={{ scale: 0.98 }}
				className="group relative isolate flex h-full min-h-[232px] flex-col overflow-hidden rounded-[28px] p-5 text-on-primary-container shadow-[0_12px_28px_-14px_color-mix(in_oklch,var(--m3-primary)_70%,transparent)] sm:p-6 lg:p-7"
				style={{ backgroundImage: "linear-gradient(135deg, var(--m3-primary-container), var(--m3-tertiary-container))" }}
			>
				{/* Soft artwork glow in the corner. */}
				{view.image && (
					// eslint-disable-next-line @next/next/no-img-element
					<img aria-hidden src={view.image} alt="" className="pointer-events-none absolute -right-16 -top-16 -z-10 size-72 rounded-full object-cover opacity-30 blur-3xl saturate-150" />
				)}
				{view.href ? (
					<Link href={view.href} aria-label={`Open ${view.title}`} className="absolute inset-0 z-0 rounded-[28px]" />
				) : (
					<button type="button" aria-label={playing ? `Pause ${view.title}` : `Play ${view.title}`} onClick={activate} className="absolute inset-0 z-0 rounded-[28px]" />
				)}
				<div className="pointer-events-none relative flex items-end">
					<span className={cn("relative block size-28 shrink-0 overflow-hidden shadow-[0_8px_20px_-4px_rgb(0_0_0/0.35)] transition-transform duration-500 ease-[cubic-bezier(0.2,0,0,1)] group-hover:scale-[1.03] lg:size-36", view.circle ? "rounded-full" : "rounded-[20px]")}>
						<Art src={view.image} size={500} className="size-full" />
						<AnimatePresence>
							{isCurrent && (
								<motion.span initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="absolute inset-0 flex items-center justify-center bg-black/45 text-white">
									<Equalizer playing={playing} className="h-7" />
								</motion.span>
							)}
						</AnimatePresence>
					</span>
					<span className="flex-1" />
					{view.track ? (
						<motion.button
							type="button"
							tabIndex={-1}
							aria-hidden
							onClick={activate}
							whileTap={{ scale: 0.9 }}
							className="pointer-events-auto flex size-[60px] items-center justify-center rounded-full bg-primary text-primary-foreground shadow-[0_8px_20px_-4px_color-mix(in_oklch,var(--m3-primary)_60%,transparent)] transition-transform hover:scale-105"
						>
							<PlayPauseIcon playing={playing} className="size-8" />
						</motion.button>
					) : (
						<span className="flex size-14 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-[0_8px_20px_-4px_color-mix(in_oklch,var(--m3-primary)_60%,transparent)] transition-transform duration-300 group-hover:translate-x-1">
							<ArrowRight className="size-7" />
						</span>
					)}
				</div>
				<div className="pointer-events-none relative mt-auto pt-5">
					<p className="type-eyebrow text-on-primary-container/75">Top result</p>
					<p className="mt-1 line-clamp-2 text-[1.75rem] font-semibold leading-[1.1] tracking-[-0.03em] lg:text-[2.25rem]">{view.title}</p>
					<div className="mt-2.5 flex min-w-0 items-center gap-2">
						<KindPill tone="primary">{view.kind}</KindPill>
						{view.artist ? (
							<span className="truncate text-sm">
								<ArtistLink id={view.artist.id} name={view.artist.name} className="pointer-events-auto" />
							</span>
						) : (
							view.subtitle && <span className="truncate text-sm">{view.subtitle}</span>
						)}
					</div>
				</div>
			</motion.div>
		</CoverTheme>
	);
}

function AllSkeleton() {
	return (
		<div className="grid gap-x-8 pt-2 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
			<Skeleton className="h-[232px] rounded-[28px] lg:h-[300px]" />
			<div>
				<Skeleton className="mb-4 mt-10 h-6 w-28 lg:mt-1" />
				<TrackSkeletons count={5} />
			</div>
		</div>
	);
}

function TrackSkeletons({ count }: { count: number }) {
	return (
		<div className="space-y-1">
			{Array.from({ length: count }, (_, k) => (
				<div key={k} className="flex items-center gap-3 py-2">
					<Skeleton className="size-12 shrink-0 rounded-lg" />
					<div className="flex-1 space-y-2">
						<Skeleton className="h-3.5 w-2/5" />
						<Skeleton className="h-3 w-1/4" />
					</div>
					<Skeleton className="h-3 w-10" />
				</div>
			))}
		</div>
	);
}

// ─── One type ───────────────────────────────────────────────────────────────

export function TypedResults({ term, tab, albumMap }: { term: string; tab: Exclude<SearchTab, "all">; albumMap: Map<string, string> }) {
	const { page, error, loading, hasMore, loadingMore, loadMore, retry } = useTypedSearch(term, tab);
	const label = TABS.find((t) => t.value === tab)!.label;

	return (
		<AnimatePresence mode="wait" initial={false}>
			{loading ? (
				<motion.div key="loading" variants={swap} initial="initial" animate="animate" exit="exit" className="pt-4">
					{tab === "track" ? (
						<TrackSkeletons count={8} />
					) : (
						<CardGrid className={cn(tab === "artist" && "lg:grid-cols-6")}>
							{Array.from({ length: 10 }, (_, k) => (
								<div key={k} className="p-1.5">
									<Skeleton className={cn("aspect-square", tab === "artist" ? "rounded-full" : "rounded-xl")} />
									<Skeleton className={cn("mt-2.5 h-3.5 w-3/4", tab === "artist" && "mx-auto")} />
									<Skeleton className={cn("mt-1.5 h-3 w-1/2", tab === "artist" && "mx-auto")} />
								</div>
							))}
						</CardGrid>
					)}
				</motion.div>
			) : error || !page ? (
				<motion.div key="error" variants={swap} initial="initial" animate="animate" exit="exit">
					<Retry onRetry={retry} message={error} />
				</motion.div>
			) : page.data.length === 0 ? (
				<motion.div key="empty" variants={swap} initial="initial" animate="animate" exit="exit">
					<Medallion icon={SearchX} title={`No ${label.toLowerCase()}`} message={`Nothing matched “${term}”.`} />
				</motion.div>
			) : (
				<motion.div key="data" variants={swap} initial="initial" animate="animate" exit="exit" className="pt-2">
					{tab === "track" && <TrackResults tracks={page.data} total={page.total} />}
					{tab === "album" && (
						<CardGrid>
							{page.data.map((raw, i) => {
								const a = albumProps(raw);
								return (
									<MediaCard
										key={`${a.id}-${i}`}
										index={i % 20}
										href={`/album?id=${a.id}`}
										title={a.title}
										subtitle={albumByline(a)}
										cover={a.cover}
										collection={{ type: "album", id: a.id }}
										badge={albumMap.has(a.id) ? <SavedBadge /> : undefined}
									/>
								);
							})}
						</CardGrid>
					)}
					{tab === "artist" && (
						<CardGrid className="lg:grid-cols-6">
							{page.data.map((raw, i) => {
								const a = artistProps(raw);
								return <MediaCard key={`${a.id}-${i}`} index={i % 20} href={`/artist?id=${a.id}`} title={a.name} subtitle={artistSubtitle(a)} cover={a.picture} round />;
							})}
						</CardGrid>
					)}
					{tab === "playlist" && (
						<CardGrid>
							{page.data.map((raw, i) => {
								const p = playlistProps(raw);
								return <MediaCard key={`${p.id}-${i}`} index={i % 20} href={`/playlist?id=${p.id}`} title={p.title} subtitle={playlistSubtitle(p)} cover={p.picture} collection={{ type: "playlist", id: p.id }} />;
							})}
						</CardGrid>
					)}
					<LoadMore hasMore={hasMore} loading={loadingMore} onMore={loadMore} />
				</motion.div>
			)}
		</AnimatePresence>
	);
}

/** Loads the next page as the end scrolls into view (button as a fallback). */
function LoadMore({ hasMore, loading, onMore }: { hasMore: boolean; loading: boolean; onMore: () => void }) {
	const ref = useRef<HTMLDivElement>(null);
	useEffect(() => {
		const el = ref.current;
		if (!el || !hasMore || typeof IntersectionObserver === "undefined") return;
		const io = new IntersectionObserver((entries) => entries[0]?.isIntersecting && onMore(), { rootMargin: "600px 0px" });
		io.observe(el);
		return () => io.disconnect();
	}, [hasMore, onMore]);

	if (!hasMore) return <div className="h-6" />;
	return (
		<div ref={ref} className="flex justify-center pb-4 pt-8">
			<motion.button
				type="button"
				whileTap={{ scale: 0.95 }}
				onClick={onMore}
				disabled={loading}
				className="inline-flex h-11 items-center gap-2 rounded-full bg-secondary px-5 text-sm font-semibold text-secondary-foreground transition-colors hover:bg-secondary/80 disabled:opacity-80"
			>
				{loading ? <Spinner size={16} /> : null}
				{loading ? "Loading…" : "Load more"}
			</motion.button>
		</div>
	);
}

function TrackResults({ tracks, total }: { tracks: GwResults[]; total?: number }) {
	const normalized = useMemo<TrackRowTrack[]>(() => tracks.map((t) => trackFromDeezerRaw(t)), [tracks]);
	const enqueue = useDownloadStore((s) => s.enqueue);
	const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
	const openPalette = useCommandStore((s) => s.open);

	const downloadAll = () => {
		if (!isAuthenticated) {
			toast("Sign in to download");
			return;
		}
		const n = enqueue(normalized, "Search results");
		toast.success(n ? `Downloading ${n} tracks` : "Already in your downloads", {
			action: { label: "View", onClick: () => openPalette(undefined, "downloads") },
		});
	};

	return (
		<div>
			<div className="mb-2 flex items-center justify-between gap-3">
				<p className="text-sm text-muted-foreground">
					{normalized.length}
					{total && total > normalized.length ? ` of ${total}` : ""} tracks
				</p>
				<motion.button
					type="button"
					whileTap={{ scale: 0.95 }}
					onClick={downloadAll}
					className="inline-flex h-10 items-center gap-2 rounded-full bg-secondary px-4 text-sm font-semibold text-secondary-foreground transition-colors hover:bg-secondary/80"
				>
					<DownloadGlyph />
					Download {normalized.length} tracks
				</motion.button>
			</div>
			<VirtualRows className="-mx-2" gap={1} items={normalized} getKey={(t) => t.trackId} render={(t) => <TrackRow track={t} queue={normalized} />} />
		</div>
	);
}
