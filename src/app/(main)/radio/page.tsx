"use client";

import { Suspense, useMemo } from "react";
import { useSearchParams } from "next/navigation";
import { AnimatePresence, motion } from "motion/react";
import { toast } from "sonner";
import { Clock3, ListChecks, ListVideo, LogIn, Music2, Radio } from "lucide-react";
import { TrackRow, type TrackRowTrack } from "@/components/tracks/TrackRow";
import { LoadFailed } from "@/components/collection/LoadFailed";
import { AlbumDetailSkeleton } from "@/components/skeletons";
import { CollectionScaffold, Medallion, SPRING, SectionTitle, TonalIconButton, entrance, swap } from "@/components/expressive";
import { SignInLink } from "@/components/links/SignInLink";
import { ArtistLink } from "@/components/links/EntityLink";
import { filledButton } from "@/components/playlists/PlaylistDialogs";
import { usePlayerStore } from "@/stores/usePlayerStore";
import { TRACK_RADIO_SOURCE, radioIsUpNext, radioQueue, useTrackRadio, type TrackRadio } from "@/hooks/useTrackRadio";
import { formatTotal, plural } from "@/lib/collection-page";
import { artistHref } from "@/lib/entity-links";

/** Rows rise in as they scroll into view (Flutter `ScrollReveal`, lighter for lists). */
const rowReveal = {
	initial: { opacity: 0.2, y: 12 },
	whileInView: { opacity: 1, y: 0 },
	viewport: { once: true, margin: "0px 0px -24px 0px" },
	transition: { duration: 0.36, ease: [0.05, 0.7, 0.1, 1] },
} as const;

function RadioContent() {
	const trackId = useSearchParams().get("track");
	const { state, retry } = useTrackRadio(trackId);

	return (
		<AnimatePresence mode="wait" initial={false}>
			<motion.div key={state.status === "ready" ? `radio-${state.radio.seed.trackId}` : state.status} variants={swap} initial="initial" animate="animate" exit="exit">
				{state.status === "loading" ? (
					<AlbumDetailSkeleton />
				) : state.status === "ready" ? (
					<RadioView radio={state.radio} />
				) : state.status === "error" ? (
					<LoadFailed what="radio" onRetry={retry} />
				) : state.status === "signed-out" ? (
					<Medallion
						icon={Radio}
						title="Song radio"
						message="Sign in to discover songs that sound like this one."
						className="mt-10"
						action={
							<SignInLink className={filledButton}>
								<LogIn />
								Sign in
							</SignInLink>
						}
					/>
				) : (
					<Medallion icon={Radio} title="No radio for this song" message="This track isn't in the Deezer catalogue." className="mt-10" />
				)}
			</motion.div>
		</AnimatePresence>
	);
}

function RadioView({ radio }: { radio: TrackRadio }) {
	const playQueue = usePlayerStore((s) => s.playQueue);
	const toggleShuffle = usePlayerStore((s) => s.toggleShuffle);

	const queue = useMemo(() => radioQueue(radio), [radio]);
	const rows = useMemo<TrackRowTrack[]>(() => queue.map((t) => ({ ...t, bitrateLabel: null })), [queue]);
	const covers = useMemo(() => [...new Set(radio.tracks.map((t) => t.cover).filter((c): c is string => !!c))], [radio.tracks]);
	const total = queue.reduce((s, t) => s + (t.duration ?? 0), 0);
	const { seed } = radio;

	const play = () => playQueue(queue, 0);
	const shuffle = () => {
		if (!usePlayerStore.getState().shuffle) toggleShuffle();
		playQueue(queue, Math.floor(Math.random() * queue.length));
	};

	const stats = [{ icon: Music2, label: plural(queue.length, "song") }, ...(total ? [{ icon: Clock3, label: formatTotal(total) }] : [])];

	return (
		<CollectionScaffold
			title={seed.title}
			cover={seed.cover}
			eyebrow="Song radio"
			subtitle={{ label: seed.artist, href: artistHref(seed.artistId, seed.artist) ?? undefined }}
			stats={stats}
			trackIds={queue.map((t) => t.trackId)}
			onPlay={play}
			onShuffle={radio.tracks.length > 0 ? shuffle : undefined}
			playLabel="Play radio"
			backdropCovers={covers}
			actions={<PlayAfterSeedButton radio={radio} />}
		>
			<section aria-label="Radio" className="mt-6 min-w-0">
				<motion.div {...entrance(1)} className="-mx-2">
					<TrackRow
						track={rows[0]}
						queue={rows}
						subtitle={
							<span className="inline-flex min-w-0 items-center gap-1.5">
								<span className="shrink-0 rounded-full bg-primary-container px-2 py-px text-[11px] font-semibold text-on-primary-container">Seed</span>
								<ArtistLink id={seed.artistId} name={seed.artist} className="truncate transition-colors hover:text-foreground" />
							</span>
						}
					/>
				</motion.div>
				{radio.tracks.length === 0 ? (
					<Medallion icon={Radio} title="Nothing similar yet" message="Try again later, or start a radio from another song." className="mt-8" />
				) : (
					<>
						<SectionTitle eyebrow="Discover" title="Songs like it" count={radio.tracks.length} className="mt-8" />
						<div className="-mx-2 space-y-0.5">
							{rows.slice(1).map((t) => (
								<motion.div key={t.trackId} {...rowReveal}>
									<TrackRow
										track={t}
										queue={rows}
										subtitle={<ArtistLink id={t.artistId} name={t.artist} className="transition-colors hover:text-foreground" />}
									/>
								</motion.div>
							))}
						</div>
					</>
				)}
			</section>
		</CollectionScaffold>
	);
}

/** While the seed plays: keeps it going and lines the radio up behind it. */
function PlayAfterSeedButton({ radio }: { radio: TrackRadio }) {
	const seedPlaying = usePlayerStore((s) => s.currentTrack?.trackId === radio.seed.trackId);
	const queued = usePlayerStore((s) => radioIsUpNext(radio, s.queue, s.queueIndex));
	if (!seedPlaying || radio.tracks.length === 0) return null;

	const queueRadio = () => {
		if (queued) return;
		const player = usePlayerStore.getState();
		player.clearQueue();
		for (const t of radio.tracks) player.addToQueue({ ...t, source: TRACK_RADIO_SOURCE });
		toast("Radio plays after this song");
	};

	return (
		<TonalIconButton label={queued ? "Radio is up next" : "Play after this song"} active={queued} onClick={queueRadio}>
			<AnimatePresence mode="popLayout" initial={false}>
				<motion.span key={String(queued)} initial={{ scale: 0.3, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.3, opacity: 0 }} transition={SPRING.pop} className="flex">
					{queued ? <ListChecks /> : <ListVideo />}
				</motion.span>
			</AnimatePresence>
		</TonalIconButton>
	);
}

export default function RadioPage() {
	return (
		<Suspense fallback={<AlbumDetailSkeleton />}>
			<RadioContent />
		</Suspense>
	);
}
