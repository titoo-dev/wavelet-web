"use client";

import { Suspense, useMemo } from "react";
import { useSearchParams } from "next/navigation";
import { AnimatePresence, motion } from "motion/react";
import { Clock3, ListMusic, Music2 } from "lucide-react";
import { TrackRow, trackFromDeezerRaw, type TrackRowTrack } from "@/components/tracks/TrackRow";
import { useTracklist } from "@/components/collection/useTracklist";
import { LoadFailed } from "@/components/collection/LoadFailed";
import { NoMatches, TrackFilter, useTrackFilter } from "@/components/collection/TrackFilter";
import { PlaylistDetailSkeleton } from "@/components/skeletons";
import { AddTracksToPlaylist, DownloadCollectionButton, useCollectionPlayback } from "@/components/collection/CollectionActions";
import { CollectionScaffold, Medallion, swap } from "@/components/expressive";
import { formatTotal, parsePlaylistPage, plural, trackCovers, type PlaylistPageData } from "@/lib/collection-page";
import { VirtualRows } from "@/components/virtual/VirtualRows";

const rowReveal = {
	initial: { opacity: 0.2, y: 12 },
	whileInView: { opacity: 1, y: 0 },
	viewport: { once: true, margin: "0px 0px -24px 0px" },
	transition: { duration: 0.36, ease: [0.05, 0.7, 0.1, 1] },
} as const;

function PlaylistContent() {
	const id = useSearchParams().get("id");
	const { page, status, retry } = useTracklist("playlist", id, parsePlaylistPage);

	return (
		<AnimatePresence mode="wait" initial={false}>
			<motion.div key={status === "ready" ? `playlist-${page?.id}` : status} variants={swap} initial="initial" animate="animate" exit="exit">
				{status === "loading" ? (
					<PlaylistDetailSkeleton />
				) : status === "ready" && page ? (
					<PlaylistView page={page} />
				) : status === "error" ? (
					<LoadFailed what="playlist" onRetry={retry} />
				) : (
					<Medallion icon={ListMusic} title="Playlist not found" message="The playlist you're looking for doesn't exist or is unavailable." className="mt-10" />
				)}
			</motion.div>
		</AnimatePresence>
	);
}

function PlaylistView({ page }: { page: PlaylistPageData }) {
	const tracks = useMemo<TrackRowTrack[]>(() => page.tracks.map((t) => trackFromDeezerRaw(t)), [page]);
	const covers = useMemo(() => trackCovers(tracks.map((t) => t.cover)), [tracks]);
	const { play, shuffle, trackIds } = useCollectionPlayback(tracks);
	const filter = useTrackFilter();
	const { active, match } = filter;
	const shown = useMemo(() => (active ? tracks.filter(match) : tracks), [tracks, active, match]);

	const stats = [
		{ icon: Music2, label: plural(tracks.length, "track") },
		...(page.duration ? [{ icon: Clock3, label: formatTotal(page.duration) }] : []),
	];

	return (
		<CollectionScaffold
			title={page.title}
			cover={page.cover}
			eyebrow="Deezer playlist"
			subtitle={page.creator ? { label: `By ${page.creator}` } : null}
			stats={stats}
			description={page.description ? <p className="line-clamp-3">{page.description}</p> : undefined}
			backdropCovers={covers}
			trackIds={trackIds}
			onPlay={play}
			onShuffle={shuffle}
			playLabel="Play playlist"
			actions={
				<>
					<AddTracksToPlaylist tracks={tracks} label="Copy to my playlist" />
					<DownloadCollectionButton tracks={tracks} group={`Playlist · ${page.title}`} label="Download playlist" />
				</>
			}
		>
			<section aria-label="Tracklist" className="mt-6">
				{tracks.length > 1 && <TrackFilter value={filter.query} onChange={filter.setQuery} className="mb-2" />}
				{tracks.length === 0 ? (
					<Medallion icon={ListMusic} title="This playlist is empty" />
				) : shown.length === 0 ? (
					<NoMatches query={filter.searched} />
				) : (
					<VirtualRows
						className="-mx-2"
						gap={2}
						items={shown}
						getKey={(t, i) => `${t.trackId}-${i}`}
						render={(t) => (
							<motion.div {...rowReveal}>
								<TrackRow track={t} queue={tracks} />
							</motion.div>
						)}
					/>
				)}
			</section>
		</CollectionScaffold>
	);
}

export default function PlaylistPage() {
	return (
		<Suspense fallback={<PlaylistDetailSkeleton />}>
			<PlaylistContent />
		</Suspense>
	);
}
