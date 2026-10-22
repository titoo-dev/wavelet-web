"use client";

import { useMemo, useState } from "react";
import { SignInLink } from "@/components/links/SignInLink";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { motion, AnimatePresence } from "motion/react";
import { toast } from "sonner";
import { ArrowDownAZ, Clock3, Disc3, Heart, ListMusic, LogIn, Search, Shuffle, User, ChevronDown, Library } from "lucide-react";
import { TrackRow, type TrackRowTrack } from "@/components/tracks/TrackRow";
import { MediaCard, CardGrid } from "@/components/cards/MediaCard";
import { DownloadGlyph, Equalizer, LogoMark, PlayPauseIcon } from "@/components/motion/icons";
import { useCommandStore } from "@/stores/useCommandStore";
import { usePlayerStore, type PlayerTrack } from "@/stores/usePlayerStore";
import { useDownloadStore } from "@/stores/useDownloadStore";
import { useDiscover } from "@/hooks/useDiscover";
import { cn } from "@/lib/utils";
import { sizedCover } from "@/lib/cover-palette";
import { artistHref } from "@/lib/entity-links";
import { ArtistLink } from "@/components/links/EntityLink";
import {
	ArtCarousel,
	Art,
	CardCarousel,
	FilterPills,
	GlassPill,
	HeroBanner,
	HeroEyebrow,
	HeroTitle,
	LikedArt,
	Medallion,
	QuickTile,
	SectionTitle,
	heroGlassButton,
	heroPrimaryButton,
	paletteNow,
	swap,
	entrance,
} from "@/components/expressive";
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { DailyMixCard } from "./DailyMixCard";

export interface UserPlaylist {
	id: string;
	title: string;
	description: string | null;
	updatedAt: string;
	_count: { tracks: number };
	covers?: string[];
}

export interface UserAlbum {
	id: string;
	deezerAlbumId: string;
	title: string;
	artist: string;
	coverUrl: string | null;
	trackCount: number;
	savedAt: string;
}

export interface RecentPlayItem {
	id: string;
	trackId: string;
	title: string;
	artist: string;
	album: string | null;
	albumId: string | null;
	coverUrl: string | null;
	duration: number | null;
	playedAt: string;
}

export interface SavedTrackItem {
	id: string;
	trackId: string;
	title: string;
	artist: string;
	album: string | null;
	albumId: string | null;
	coverUrl: string | null;
	duration: number | null;
	savedAt: string;
}

interface HomeContentProps {
	playlists: UserPlaylist[];
	albums: UserAlbum[];
	recentPlays: RecentPlayItem[];
	tracks: SavedTrackItem[];
	user: { name: string } | null;
}

type Filter = "all" | "tracks" | "albums" | "playlists" | "recent";
type Sort = "added" | "title" | "artist";

const PAGE = 100;

function greeting() {
	const h = new Date().getHours();
	if (h < 5) return "Up late";
	if (h < 12) return "Good morning";
	if (h < 18) return "Good afternoon";
	return "Good evening";
}

function toRow(t: SavedTrackItem | RecentPlayItem): TrackRowTrack {
	return {
		trackId: t.trackId,
		title: t.title,
		artist: t.artist,
		album: t.album,
		albumId: t.albumId,
		cover: t.coverUrl,
		duration: t.duration,
		bitrateLabel: null,
	};
}

function toPlayer(t: TrackRowTrack): PlayerTrack {
	return { trackId: t.trackId, title: t.title, artist: t.artist, artistId: t.artistId ?? null, album: t.album ?? null, albumId: t.albumId ?? null, cover: t.cover, duration: t.duration ?? null };
}

function TrackList({ tracks }: { tracks: TrackRowTrack[] }) {
	const [limit, setLimit] = useState(PAGE);
	const shown = tracks.slice(0, limit);
	return (
		<div>
			<div className="-mx-2 space-y-0.5">
				{shown.map((t, i) => (
					<TrackRow key={`${t.trackId}-${i}`} track={t} trackNumber={i + 1} showBitrate={false} queue={tracks} />
				))}
			</div>
			{tracks.length > limit && (
				<div className="mt-5 flex justify-center">
					<motion.button
						type="button"
						whileTap={{ scale: 0.95 }}
						onClick={() => setLimit((l) => l + PAGE)}
						className="inline-flex h-11 items-center gap-2 rounded-full bg-secondary px-5 text-sm font-semibold text-secondary-foreground transition-colors hover:bg-secondary/80"
					>
						<ChevronDown className="size-[18px]" />
						Show {Math.min(PAGE, tracks.length - limit)} more
					</motion.button>
				</div>
			)}
		</div>
	);
}

const SORTS: { value: Sort; label: string; short: string; icon: typeof Clock3 }[] = [
	{ value: "added", label: "Recently added", short: "Recent", icon: Clock3 },
	{ value: "title", label: "Title A–Z", short: "A–Z", icon: ArrowDownAZ },
	{ value: "artist", label: "Artist", short: "Artist", icon: User },
];

function SortPill({ sort, onChange }: { sort: Sort; onChange: (s: Sort) => void }) {
	const current = SORTS.find((s) => s.value === sort)!;
	const Icon = current.icon;
	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				aria-label="Sort tracks"
				className="flex h-9 shrink-0 items-center gap-1.5 rounded-full bg-surface-high pl-2.5 pr-3.5 text-sm font-medium outline-none transition-colors hover:bg-surface-highest focus-visible:ring-2 focus-visible:ring-ring"
			>
				<AnimatePresence mode="popLayout" initial={false}>
					<motion.span key={sort} initial={{ rotate: -90, scale: 0.6, opacity: 0 }} animate={{ rotate: 0, scale: 1, opacity: 1 }} exit={{ rotate: 90, scale: 0.6, opacity: 0 }} className="flex">
						<Icon className="size-[18px]" />
					</motion.span>
				</AnimatePresence>
				{current.short}
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end" className="w-48 rounded-2xl p-1.5">
				<DropdownMenuRadioGroup value={sort} onValueChange={(v) => onChange(v as Sort)}>
					{SORTS.map((s) => (
						<DropdownMenuRadioItem key={s.value} value={s.value} className="rounded-xl">
							{s.label}
						</DropdownMenuRadioItem>
					))}
				</DropdownMenuRadioGroup>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

// ─── Guest ──────────────────────────────────────────────────────────────────

function GuestHero({ covers }: { covers: string[] }) {
	return (
		<HeroBanner palette={paletteNow()} covers={covers} radius={32} minCovers={8} contentClassName="flex min-h-[340px] flex-col justify-end p-6 sm:min-h-[420px] sm:p-10">
			<motion.div initial={{ scale: 0.6, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ type: "spring", stiffness: 260, damping: 18 }}>
				<LogoMark animated className="size-14" />
			</motion.div>
			<motion.div initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1, duration: 0.5, ease: [0.05, 0.7, 0.1, 1] }}>
				<HeroTitle first="Every track," second="one tap away." className="mt-6 text-[2.5rem] sm:text-6xl lg:text-7xl" />
			</motion.div>
			<motion.p initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.25 }} className="mt-3 max-w-md text-base text-white/80 sm:text-lg">
				Search Deezer, stream in lossless and build your library.
			</motion.p>
			<motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.35 }} className="mt-6 flex flex-wrap gap-2">
				<SignInLink className={cn(heroPrimaryButton, "no-underline")}>
					<LogIn />
					Sign in
				</SignInLink>
				<Link href="/search" className={cn(heroGlassButton, "no-underline")}>
					<Search />
					Search
				</Link>
			</motion.div>
		</HeroBanner>
	);
}

// ─── Signed in ──────────────────────────────────────────────────────────────

function GreetingHero({
	firstName,
	covers,
	stats,
	playAll,
	onPlayAll,
	onShuffle,
	onDownloadAll,
}: {
	firstName: string;
	covers: string[];
	stats: { icon: typeof Heart; value: number; label: string }[];
	playAll: TrackRowTrack[];
	onPlayAll: () => void;
	onShuffle: () => void;
	onDownloadAll?: () => void;
}) {
	const current = usePlayerStore((s) => s.currentTrack);
	const isPlaying = usePlayerStore((s) => s.isPlaying);
	const toggle = usePlayerStore((s) => s.toggle);
	const setFullscreenOpen = usePlayerStore((s) => s.setFullscreenOpen);
	const isThis = !!current && playAll.some((t) => t.trackId === current.trackId);
	const weekday = new Date().toLocaleDateString("en", { weekday: "long" });

	return (
		<HeroBanner palette={paletteNow()} covers={covers} radius={32} minCovers={8} contentClassName="p-6 sm:p-8 lg:p-10">
			<div className="flex flex-col gap-8 lg:flex-row lg:items-end lg:justify-between">
				<div className="min-w-0">
					<HeroEyebrow className="tracking-[0.2em]">{weekday}</HeroEyebrow>
					<motion.h1
						initial={{ opacity: 0, y: 12 }}
						animate={{ opacity: 1, y: 0 }}
						transition={{ duration: 0.5, ease: [0.05, 0.7, 0.1, 1] }}
						className="type-display mt-2 text-[2.25rem] text-white sm:text-5xl lg:text-6xl"
					>
						{greeting()}
						{firstName && (
							<>
								,<br />
								<span className="brand-text">{firstName}</span>
							</>
						)}
					</motion.h1>
					<div className="mt-5 flex flex-wrap gap-2">
						{stats.map((s, i) => (
							<motion.span key={s.label} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 + i * 0.06 }}>
								<GlassPill icon={s.icon} value={s.value} label={s.label} />
							</motion.span>
						))}
					</div>
					<div className="mt-6 flex flex-wrap gap-2">
						<button type="button" disabled={!playAll.length} onClick={isThis ? toggle : onPlayAll} className={heroPrimaryButton}>
							<PlayPauseIcon playing={isThis && isPlaying} className="size-5" />
							<AnimatePresence mode="popLayout" initial={false}>
								<motion.span key={String(isThis && isPlaying)} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }}>
									{isThis && isPlaying ? "Pause" : "Play all"}
								</motion.span>
							</AnimatePresence>
						</button>
						<button type="button" disabled={!playAll.length} onClick={onShuffle} className={heroGlassButton}>
							<Shuffle />
							Shuffle
						</button>
						{onDownloadAll && (
							<button type="button" onClick={onDownloadAll} aria-label="Download all" title="Download all" className={cn(heroGlassButton, "w-11 px-0")}>
								<DownloadGlyph />
							</button>
						)}
					</div>
				</div>

				{/* What's playing, inside the hero; opens the player. */}
				<AnimatePresence>
					{current && (
						<motion.div
							initial={{ opacity: 0, height: 0 }}
							animate={{ opacity: 1, height: "auto" }}
							exit={{ opacity: 0, height: 0 }}
							whileTap={{ scale: 0.97 }}
							className="relative flex w-full items-center gap-3 overflow-hidden rounded-[20px] bg-white/[0.14] p-2 text-left backdrop-blur-md transition-colors hover:bg-white/20 has-[>button:focus-visible]:ring-2 has-[>button:focus-visible]:ring-white/60 lg:w-[340px]"
						>
							{/* Opens the player; a layer under the click-through content so the artist name links on its own. */}
							<button type="button" onClick={() => setFullscreenOpen(true)} aria-label={`Open player: ${current.title} · ${current.artist}`} className="absolute inset-0 rounded-[inherit] outline-none" />
							{/* eslint-disable-next-line @next/next/no-img-element */}
							<img src={current.cover ? sizedCover(current.cover, 120) : undefined} alt="" className="pointer-events-none relative size-11 shrink-0 rounded-xl bg-white/10 object-cover" />
							<span className="pointer-events-none relative min-w-0 flex-1">
								<span className="type-eyebrow block text-[10px] text-white/70">{isPlaying ? "Now playing" : "Paused"}</span>
								<AnimatePresence mode="popLayout" initial={false}>
									<motion.span key={current.trackId} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} className="block truncate text-sm font-semibold text-white">
										{current.title} · <ArtistLink id={current.artistId} name={current.artist} className="pointer-events-auto" />
									</motion.span>
								</AnimatePresence>
							</span>
							<Equalizer playing={isPlaying} className="pointer-events-none relative mr-2 h-4 text-white" />
						</motion.div>
					)}
				</AnimatePresence>
			</div>
		</HeroBanner>
	);
}

// ─── Discover (everyone) ────────────────────────────────────────────────────

function Discover({ savedAlbumIds }: { savedAlbumIds: Set<string> }) {
	// Rendered only once there is content: a skeleton here would flash and then
	// vanish whenever Deezer has nothing to show (e.g. no editorial releases).
	const { releases, sections } = useDiscover();
	const router = useRouter();
	return (
		<>
			{releases.length > 0 && (
				<motion.section {...entrance()}>
					<SectionTitle eyebrow="Fresh on Deezer" title="New releases" />
					<ArtCarousel
						label="New releases"
						height={280}
						lead={1.9}
						items={releases.slice(0, 30).map((a) => ({ key: a.id, title: a.title, subtitle: a.artist, subtitleHref: artistHref(null, a.artist), image: a.cover }))}
						onSelect={(i) => router.push(`/album?id=${releases[i].id}`)}
					/>
				</motion.section>
			)}
			{sections.slice(0, 6).map((s) => (
				<section key={s.title}>
					<SectionTitle title={s.title} />
					<CardCarousel>
						{s.albums.slice(0, 20).map((a, i) => (
							<MediaCard
								key={a.id}
								index={i}
								href={`/album?id=${a.id}`}
								title={a.title}
								subtitle={a.artist ? <ArtistLink name={a.artist} className="transition-colors hover:text-foreground" /> : undefined}
								cover={a.cover}
								collection={{ type: "album", id: a.id }}
								badge={savedAlbumIds.has(a.id) ? <SavedDot /> : undefined}
							/>
						))}
					</CardCarousel>
				</section>
			))}
		</>
	);
}

function SavedDot() {
	return (
		<span className="flex size-6 items-center justify-center rounded-full bg-primary-container text-on-primary-container shadow-sm">
			<Heart className="size-3.5 fill-current" />
		</span>
	);
}

// ─── Page ───────────────────────────────────────────────────────────────────

export function HomeContent({ playlists, albums, recentPlays, tracks, user }: HomeContentProps) {
	const [filter, setFilter] = useState<Filter>("all");
	const [sort, setSort] = useState<Sort>("added");
	const openPalette = useCommandStore((s) => s.open);
	const playQueue = usePlayerStore((s) => s.playQueue);
	const play = usePlayerStore((s) => s.play);
	const toggle = usePlayerStore((s) => s.toggle);
	const current = usePlayerStore((s) => s.currentTrack);
	const isPlaying = usePlayerStore((s) => s.isPlaying);
	const shuffleOn = usePlayerStore((s) => s.shuffle);
	const toggleShuffle = usePlayerStore((s) => s.toggleShuffle);
	const enqueue = useDownloadStore((s) => s.enqueue);
	const { showcase } = useDiscover();

	const trackRows = useMemo(() => {
		const rows = tracks.map(toRow);
		if (sort === "title") rows.sort((a, b) => a.title.localeCompare(b.title));
		if (sort === "artist") rows.sort((a, b) => a.artist.localeCompare(b.artist) || a.title.localeCompare(b.title));
		return rows;
	}, [tracks, sort]);
	const recentRows = useMemo(() => {
		// Collapse repeat plays so the list reads as "what I've been into".
		const seen = new Set<string>();
		return recentPlays.filter((r) => (seen.has(r.trackId) ? false : (seen.add(r.trackId), true))).map(toRow);
	}, [recentPlays]);
	const sortedAlbums = useMemo(() => [...albums].sort((a, b) => new Date(b.savedAt).getTime() - new Date(a.savedAt).getTime()), [albums]);
	const savedAlbumIds = useMemo(() => new Set(albums.map((a) => a.deezerAlbumId)), [albums]);
	const heroCovers = useMemo(() => {
		const own = [...recentPlays.map((r) => r.coverUrl), ...tracks.map((t) => t.coverUrl), ...albums.map((a) => a.coverUrl)].filter((c): c is string => !!c);
		return [...new Set([...own, ...showcase])].slice(0, 40);
	}, [recentPlays, tracks, albums, showcase]);

	if (!user) {
		return (
			<div className="pt-2">
				<GuestHero covers={showcase} />
				<Discover savedAlbumIds={savedAlbumIds} />
			</div>
		);
	}

	const isEmpty = tracks.length === 0 && albums.length === 0 && playlists.length === 0 && recentPlays.length === 0;
	const all = filter === "all";
	const firstName = user.name?.split(" ")[0] || "";
	const source = trackRows.length ? trackRows : recentRows;

	const playAll = (shuffle: boolean) => {
		if (!source.length) return;
		if (shuffle !== shuffleOn) toggleShuffle();
		const start = shuffle ? Math.floor(Math.random() * source.length) : 0;
		playQueue(source.map(toPlayer), start);
	};

	const downloadAll = () => {
		if (!trackRows.length) return;
		const n = enqueue(trackRows, "All music");
		toast.success(n ? `Downloading ${n} tracks` : "Already in your downloads", {
			action: { label: "View", onClick: () => openPalette(undefined, "downloads") },
		});
	};

	const playRecent = (i: number) => {
		const t = recentRows[i];
		if (current?.trackId === t.trackId) return toggle();
		play(toPlayer(t), recentRows.map(toPlayer));
	};

	// Quick picks: liked songs, two playlists, two albums, then recent tracks.
	const shortcuts = [
		...(tracks.length ? [{ key: "liked", title: "Liked songs", subtitle: `${tracks.length} ${tracks.length === 1 ? "track" : "tracks"}`, art: <LikedArt className="size-full" />, onClick: () => setFilter("tracks") }] : []),
		...playlists.slice(0, 2).map((p) => ({ key: `p${p.id}`, title: p.title, subtitle: `Playlist · ${p._count.tracks} tracks`, art: <Art covers={p.covers} className="size-full" size={120} />, href: `/my-playlists/${p.id}` })),
		...sortedAlbums.slice(0, 2).map((a) => ({ key: `a${a.id}`, title: a.title, subtitle: a.artist, subtitleHref: artistHref(null, a.artist), art: <Art src={a.coverUrl} className="size-full" size={120} />, href: `/album?id=${a.deezerAlbumId}` })),
		...recentRows.map((t, i) => ({ key: `r${t.trackId}`, title: t.title, subtitle: t.artist, subtitleHref: artistHref(t.artistId, t.artist), art: <Art src={t.cover} className="size-full" size={120} />, onClick: () => playRecent(i), trackId: t.trackId })),
	].slice(0, 6);

	return (
		// More air between sections than the default rhythm (see SectionTitle).
		<div className="pb-6 [--section-gap:3.5rem] [--section-title-gap:1rem]">
			{/* Filter pills: scroll away with the page (the glass header is the only pinned bar). */}
			<div className="mb-6 py-2">
				<FilterPills<Filter>
					value={filter}
					onChange={(f) => {
						setFilter(f);
						window.scrollTo({ top: 0, behavior: "smooth" });
					}}
					items={[
						{ value: "all", label: "All" },
						{ value: "tracks", label: "Tracks", count: tracks.length },
						{ value: "albums", label: "Albums", count: albums.length },
						{ value: "playlists", label: "Playlists", count: playlists.length },
						{ value: "recent", label: "Recent" },
					]}
				/>
			</div>

			<AnimatePresence mode="wait" initial={false}>
				<motion.div key={filter} variants={swap} initial="initial" animate="animate" exit="exit">
					{all && (
						<>
							<GreetingHero
								firstName={firstName}
								covers={heroCovers}
								playAll={source}
								onPlayAll={() => playAll(false)}
								onShuffle={() => playAll(true)}
								onDownloadAll={trackRows.length ? downloadAll : undefined}
								stats={[
									{ icon: Heart, value: tracks.length, label: "liked" },
									{ icon: Disc3, value: albums.length, label: "albums" },
									{ icon: ListMusic, value: playlists.length, label: "playlists" },
								]}
							/>
							{shortcuts.length > 0 && (
								<div className="mt-6 grid grid-cols-1 gap-3 min-[480px]:grid-cols-2 lg:grid-cols-3">
									{shortcuts.map((s, i) => (
										<QuickTile
											key={s.key}
											index={i + 2}
											title={s.title}
											subtitle={s.subtitle}
											subtitleHref={"subtitleHref" in s ? s.subtitleHref : undefined}
											art={s.art}
											href={"href" in s ? s.href : undefined}
											onClick={"onClick" in s ? s.onClick : undefined}
											current={"trackId" in s && current?.trackId === s.trackId}
											playing={isPlaying}
										/>
									))}
								</div>
							)}
							<DailyMixCard />
						</>
					)}

					{isEmpty ? (
						<Medallion
							icon={Library}
							title="Your library is empty"
							message="Like tracks, save albums and create playlists — they’ll show up here."
							action={
								<Link href="/search" className="inline-flex h-11 items-center gap-2 rounded-full bg-secondary px-5 text-sm font-semibold text-secondary-foreground no-underline">
									<Search className="size-[18px]" />
									Open search
								</Link>
							}
						/>
					) : (
						<>
							{all && recentRows.length > 0 && (
								<section>
									<SectionTitle
										eyebrow="Pick up where you left off"
										title="Recently played"
										onAction={recentRows.length > 12 ? () => setFilter("recent") : undefined}
									/>
									<ArtCarousel
										label="Recently played"
										height={200}
										lead={1.6}
										items={recentRows.slice(0, 12).map((t) => ({
											key: t.trackId,
											title: t.title,
											subtitle: t.artist,
											subtitleHref: artistHref(t.artistId, t.artist),
											image: t.cover,
											current: current?.trackId === t.trackId,
											playing: isPlaying,
										}))}
										onSelect={playRecent}
									/>
								</section>
							)}

							{filter === "recent" && (
								<section>
									<SectionTitle title="Recently played" count={recentRows.length} className="mt-2" />
									{recentRows.length ? (
										<TrackList tracks={recentRows} />
									) : (
										<Medallion icon={Clock3} title="Nothing yet" message="Play a track for at least 30 seconds and it’ll show up here." />
									)}
								</section>
							)}

							{(all || filter === "albums") && sortedAlbums.length > 0 && (
								<section>
									<SectionTitle
										title="Albums"
										count={all ? null : albums.length}
										className={cn(!all && "mt-2")}
										onAction={all && albums.length > 10 ? () => setFilter("albums") : undefined}
									/>
									{all ? (
										<CardCarousel>
											{sortedAlbums.slice(0, 10).map((a, i) => (
												<MediaCard key={a.id} index={i} href={`/album?id=${a.deezerAlbumId}`} title={a.title} subtitle={<ArtistLink name={a.artist} className="transition-colors hover:text-foreground" />} cover={a.coverUrl} collection={{ type: "album", id: a.deezerAlbumId }} />
											))}
										</CardCarousel>
									) : (
										<CardGrid>
											{sortedAlbums.map((a, i) => (
												<MediaCard key={a.id} index={i} href={`/album?id=${a.deezerAlbumId}`} title={a.title} subtitle={<><ArtistLink name={a.artist} className="transition-colors hover:text-foreground" />{` · ${a.trackCount} tracks`}</>} cover={a.coverUrl} collection={{ type: "album", id: a.deezerAlbumId }} />
											))}
										</CardGrid>
									)}
								</section>
							)}
							{filter === "albums" && sortedAlbums.length === 0 && <Medallion icon={Disc3} title="No saved albums" message="Save albums with the heart on their page." />}

							{(all || filter === "playlists") && playlists.length > 0 && (
								<section>
									<SectionTitle title="Playlists" count={all ? null : playlists.length} className={cn(!all && "mt-2")} actionLabel="Manage" href="/my-playlists" />
									{all ? (
										<CardCarousel>
											{playlists.map((p, i) => (
												<MediaCard key={p.id} index={i} href={`/my-playlists/${p.id}`} title={p.title} subtitle={`${p._count.tracks} tracks`} covers={p.covers} />
											))}
										</CardCarousel>
									) : (
										<CardGrid>
											{playlists.map((p, i) => (
												<MediaCard key={p.id} index={i} href={`/my-playlists/${p.id}`} title={p.title} subtitle={`${p._count.tracks} tracks`} covers={p.covers} />
											))}
										</CardGrid>
									)}
								</section>
							)}
							{filter === "playlists" && playlists.length === 0 && <Medallion icon={ListMusic} title="No playlists" message="Collect tracks into your own mixes." />}

							{(all || filter === "tracks") && (
								<section>
									<SectionTitle
										title="Liked tracks"
										count={tracks.length}
										className={cn(!all && "mt-2")}
										trailing={trackRows.length > 1 ? <SortPill sort={sort} onChange={setSort} /> : undefined}
									/>
									{trackRows.length ? (
										<TrackList tracks={trackRows} />
									) : (
										<Medallion icon={Heart} title="No liked tracks" message="Tap the heart on any track to save it here." className="py-8" />
									)}
								</section>
							)}
						</>
					)}

					{all && <Discover savedAlbumIds={savedAlbumIds} />}
				</motion.div>
			</AnimatePresence>
		</div>
	);
}
