"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { AnimatePresence, motion } from "motion/react";
import { toast } from "sonner";
import { CalendarDays, Clock3, Copyright, Disc3, Music2, Tag } from "lucide-react";
import { HeartGlyph, Spinner } from "@/components/motion/icons";
import { useSavedAlbums } from "@/hooks/useLibrary";
import { TrackRow, trackFromDeezerRaw, type TrackRowTrack } from "@/components/tracks/TrackRow";
import { MediaCard } from "@/components/cards/MediaCard";
import { useTracklist } from "@/components/collection/useTracklist";
import { LoadFailed } from "@/components/collection/LoadFailed";
import { NoMatches, TrackFilter, useTrackFilter } from "@/components/collection/TrackFilter";
import { AlbumDetailSkeleton } from "@/components/skeletons";
import { AddTracksToPlaylist, DownloadCollectionButton, useCollectionPlayback } from "@/components/collection/CollectionActions";
import { CardCarousel, CollectionScaffold, Medallion, SPRING, SavedBadge, SectionTitle, TonalIconButton, swap } from "@/components/expressive";
import { useAuthStore } from "@/stores/useAuthStore";
import { albumRows, formatReleaseDate, formatTotal, parseAlbumPage, plural, type AlbumPageData } from "@/lib/collection-page";
import { artistHref, pickAlbumId } from "@/lib/entity-links";
import { fetchData } from "@/utils/api";
import { ArtistLink } from "@/components/links/EntityLink";
import { VirtualRows } from "@/components/virtual/VirtualRows";

/** Rows rise in as they scroll into view (Flutter `ScrollReveal`, lighter for lists). */
const rowReveal = {
	initial: { opacity: 0.2, y: 12 },
	whileInView: { opacity: 1, y: 0 },
	viewport: { once: true, margin: "0px 0px -24px 0px" },
	transition: { duration: 0.36, ease: [0.05, 0.7, 0.1, 1] },
} as const;

/**
 * `/album?title=…&artist=…` (shares and imports that never kept the album id):
 * find the Deezer album through search and swap the URL for its `?id=`. Stays
 * "loading" until the replace lands, "missing" when search has no such album,
 * "error" when the search failed (offer `retry`).
 */
function useAlbumFromTitle(title: string | null, artist: string | null) {
	const router = useRouter();
	const [attempt, setAttempt] = useState(0);
	const [outcome, setOutcome] = useState<{ key: string; status: "missing" | "error" } | null>(null);
	const key = title ? `${title}\u0000${artist ?? ""}\u0000${attempt}` : null;

	useEffect(() => {
		if (!title) return;
		let cancelled = false;
		const k = `${title}\u0000${artist ?? ""}\u0000${attempt}`;
		fetchData("search", { term: [artist, title].filter(Boolean).join(" "), type: "album", start: "0", nb: "10" })
			.then((res) => {
				if (cancelled) return;
				const id = pickAlbumId(title, artist, Array.isArray(res?.data) ? res.data : []);
				if (id) router.replace(`/album?id=${encodeURIComponent(id)}`);
				else setOutcome({ key: k, status: "missing" });
			})
			.catch(() => !cancelled && setOutcome({ key: k, status: "error" }));
		return () => {
			cancelled = true;
		};
	}, [title, artist, attempt, router]);

	const retry = useCallback(() => setAttempt((a) => a + 1), []);
	return { status: key && outcome?.key === key ? outcome.status : ("loading" as const), retry };
}

function AlbumContent() {
	const params = useSearchParams();
	const id = params.get("id");
	const title = params.get("title");
	const byTitle = useAlbumFromTitle(id ? null : title, params.get("artist"));
	const tracklist = useTracklist("album", id, parseAlbumPage);
	const page = tracklist.page;
	const status = id ? tracklist.status : title ? byTitle.status : "missing";
	const retry = id ? tracklist.retry : byTitle.retry;

	return (
		<AnimatePresence mode="wait" initial={false}>
			<motion.div key={status === "ready" ? `album-${page?.id}` : status} variants={swap} initial="initial" animate="animate" exit="exit">
				{status === "loading" ? (
					<AlbumDetailSkeleton />
				) : status === "ready" && page ? (
					<AlbumView page={page} />
				) : status === "error" ? (
					<LoadFailed what="album" onRetry={retry} />
				) : (
					<Medallion icon={Disc3} title="Album not found" message="The album you're looking for doesn't exist or is unavailable." className="mt-10" />
				)}
			</motion.div>
		</AnimatePresence>
	);
}

/** Tonal heart that pops when the album is saved. */
function SaveAlbumButton({ saved, saving, onClick }: { saved: boolean; saving: boolean; onClick: () => void }) {
	return (
		<TonalIconButton label={saved ? "Remove from library" : "Save album"} active={saved} onClick={onClick} disabled={saving}>
			<AnimatePresence mode="popLayout" initial={false}>
				<motion.span
					key={saving ? "busy" : String(saved)}
					initial={{ scale: 0.3, opacity: 0 }}
					animate={{ scale: 1, opacity: 1 }}
					exit={{ scale: 0.3, opacity: 0 }}
					transition={SPRING.pop}
					className="flex"
				>
					{saving ? <Spinner /> : <HeartGlyph filled={saved} />}
				</motion.span>
			</AnimatePresence>
		</TonalIconButton>
	);
}

function AlbumView({ page }: { page: AlbumPageData }) {
	const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
	const [saving, setSaving] = useState(false);
	const moreIds = useMemo(() => [page.id, ...page.moreByArtist.map((a) => a.id)], [page]);
	const { isSaved, save, unsave } = useSavedAlbums(moreIds);
	const saved = isSaved(page.id);

	const tracks = useMemo<TrackRowTrack[]>(() => page.tracks.map((t) => trackFromDeezerRaw(t)), [page]);
	const filter = useTrackFilter();
	const { active, match } = filter;
	const rows = useMemo(() => albumRows(page.discs, active ? (i) => match(tracks[i]) : undefined), [page, tracks, active, match]);
	const { play, shuffle, trackIds } = useCollectionPlayback(tracks);

	const toggleSave = async () => {
		setSaving(true);
		try {
			if (saved) {
				// Unsaving needs the library's own Album.id.
				const res = await fetch("/api/v1/library/albums", { credentials: "include" });
				const json = await res.json();
				const items = (json?.data?.items as { id: string; deezerAlbumId: string }[]) || [];
				const match = items.find((a) => String(a.deezerAlbumId) === page.id);
				if (match) await unsave(String(match.id), page.id);
				toast("Removed from your library");
			} else {
				await save({
					deezerAlbumId: page.id,
					title: page.title,
					artist: page.artist ?? "",
					coverUrl: page.cover,
					tracks: tracks.map((t, i) => ({
						trackId: t.trackId,
						title: t.title,
						artist: t.artist,
						coverUrl: t.cover,
						duration: t.duration ?? null,
						trackNumber: Number((page.tracks[i] as { TRACK_NUMBER?: string })?.TRACK_NUMBER) || i + 1,
					})),
				});
				toast.success("Saved to your library");
			}
		} catch (e) {
			console.error("[album save] failed:", e);
			toast.error("Couldn't update your library");
		}
		setSaving(false);
	};

	const stats = [
		{ icon: Music2, label: plural(tracks.length, "track") },
		...(page.duration ? [{ icon: Clock3, label: formatTotal(page.duration) }] : []),
		...(page.discCount > 1 ? [{ icon: Disc3, label: plural(page.discCount, "disc") }] : []),
	];

	return (
		<CollectionScaffold
			title={page.title}
			cover={page.cover}
			eyebrow={[page.recordType, page.year].filter(Boolean).join(" · ")}
			subtitle={page.artist ? { label: page.artist, href: artistHref(page.artistId, page.artist) ?? undefined, image: page.artistPicture } : null}
			stats={stats}
			trackIds={trackIds}
			onPlay={play}
			onShuffle={shuffle}
			playLabel="Play album"
			actions={
				<>
					{isAuthenticated && <SaveAlbumButton saved={saved} saving={saving} onClick={toggleSave} />}
					<AddTracksToPlaylist tracks={tracks} />
					<DownloadCollectionButton tracks={tracks} group={`Album · ${page.title}`} label="Download album" />
				</>
			}
		>
			<div className="mt-6 grid items-start gap-x-10 gap-y-6 lg:grid-cols-[minmax(0,1fr)_320px]">
				<section aria-label="Tracklist" className="min-w-0">
					{tracks.length > 1 && <TrackFilter value={filter.query} onChange={filter.setQuery} placeholder="Search in album" className="mb-2" />}
					{tracks.length === 0 ? (
						<Medallion icon={Disc3} title="No tracks" message="The tracklist for this album is unavailable." />
					) : rows.length === 0 ? (
						<NoMatches query={filter.searched} />
					) : (
						<VirtualRows
							className="-mx-2"
							gap={2}
							items={rows}
							getKey={(row) => (row.kind === "disc" ? `disc-${row.disc}` : `${tracks[row.index].trackId}-${row.index}`)}
							estimateSize={(row) => (row.kind === "disc" ? 56 : 60)}
							render={(row) =>
								row.kind === "disc" ? (
									<DiscHeader disc={row.disc} first={row === rows[0]} />
								) : (
									<motion.div {...rowReveal}>
										<TrackRow
											track={tracks[row.index]}
											trackNumber={Number((page.tracks[row.index] as { TRACK_NUMBER?: string })?.TRACK_NUMBER) || row.index + 1}
											queue={tracks}
											showCover={false}
											subtitle={<ArtistLink id={tracks[row.index].artistId} name={tracks[row.index].artist} className="transition-colors hover:text-foreground" />}
										/>
									</motion.div>
								)
							}
						/>
					)}
				</section>
				<Credits page={page} />
			</div>

			{page.moreByArtist.length > 0 && (
				<section>
					<SectionTitle
						eyebrow="Discography"
						title={page.artist ? `More by ${page.artist}` : "More albums"}
						actionLabel="Artist"
						href={artistHref(page.artistId, page.artist) ?? undefined}
					/>
					<CardCarousel>
						{page.moreByArtist.slice(0, 12).map((a, i) => (
							<MediaCard
								key={a.id}
								index={i}
								href={`/album?id=${a.id}`}
								title={a.title}
								subtitle={[a.year, a.recordType].filter(Boolean).join(" · ") || undefined}
								cover={a.cover}
								collection={{ type: "album", id: a.id }}
								badge={isSaved(a.id) ? <SavedBadge /> : undefined}
							/>
						))}
					</CardCarousel>
				</section>
			)}
		</CollectionScaffold>
	);
}

/** "Disc N" tertiary pill with a rule running out to the edge. */
function DiscHeader({ disc, first }: { disc: number; first: boolean }) {
	return (
		<motion.div {...rowReveal} className={first ? "flex items-center gap-3 px-2 pb-2" : "flex items-center gap-3 px-2 pb-2 pt-6"}>
			<span className="inline-flex h-8 items-center gap-1.5 rounded-full bg-tertiary-container pl-2 pr-3 text-sm font-semibold text-on-tertiary-container">
				<Disc3 className="size-4" />
				Disc {disc}
			</span>
			<span className="h-px flex-1 bg-outline-variant" />
		</motion.div>
	);
}

/** Release date and label / copyright on a tonal card. */
function Credits({ page }: { page: AlbumPageData }) {
	const lines = [
		...(page.releaseDate ? [{ icon: CalendarDays, text: `Released ${formatReleaseDate(page.releaseDate)}` }] : []),
		...(page.copyright ? [{ icon: Copyright, text: page.copyright }] : []),
		...(page.label && !page.copyright ? [{ icon: Tag, text: `℗ ${page.label}` }] : []),
		...(page.label && page.copyright && !page.copyright.includes(page.label) ? [{ icon: Tag, text: page.label }] : []),
	];
	if (!lines.length) return null;
	return (
		<motion.aside {...rowReveal} aria-label="Credits" className="rounded-[20px] bg-surface-low p-5 lg:sticky lg:top-[calc(var(--header-h)+80px)]">
			<p className="type-eyebrow mb-3 text-primary">Credits</p>
			<ul className="space-y-3">
				{lines.map(({ icon: Icon, text }) => (
					<li key={text} className="flex items-start gap-3 text-sm leading-snug text-muted-foreground">
						<Icon className="mt-px size-[18px] shrink-0 text-primary" />
						<span className="min-w-0 break-words">{text}</span>
					</li>
				))}
			</ul>
		</motion.aside>
	);
}

export default function AlbumPage() {
	return (
		<Suspense fallback={<AlbumDetailSkeleton />}>
			<AlbumContent />
		</Suspense>
	);
}
