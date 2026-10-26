"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { AnimatePresence, motion, Reorder, useDragControls } from "motion/react";
import { toast } from "sonner";
import { ArrowLeft, Clock3, GripVertical, History, ListPlus, MoreHorizontal, Music, Pencil, Search, Trash2, ArrowDownUp, LogIn } from "lucide-react";
import { useAuthStore } from "@/stores/useAuthStore";
import { usePlayerStore, type PlayerTrack } from "@/stores/usePlayerStore";
import { TrackRow, type TrackRowTrack } from "@/components/tracks/TrackRow";
import { CollectionScaffold, Medallion, SlidingSegments, TonalIconButton, swap } from "@/components/expressive";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { preloadTrack } from "@/components/audio/AudioEngine";
import { useUserPreferences } from "@/hooks/useUserPreferences";
import { usePrefetch } from "@/hooks/usePrefetch";
import { useWindowRows } from "@/hooks/useVirtualRows";
import { useLoginHref } from "@/hooks/useLoginHref";
import { trailingSend } from "@/lib/trailing-send";
import { DeletePlaylistDialog, PlaylistEditDialog, filledButton, tonalButton } from "@/components/playlists/PlaylistDialogs";
import { PlaylistDetailSkeleton } from "@/components/playlists/PlaylistTiles";
import { NoMatches, TrackFilter, useTrackFilter } from "@/components/collection/TrackFilter";
import { formatRelative, formatTotal, plural, uniqueCovers } from "@/components/playlists/format";

interface PlaylistTrack {
	id: string;
	trackId: string;
	title: string;
	artist: string;
	album: string | null;
	albumId?: string | null;
	coverUrl: string | null;
	duration: number | null;
	position: number;
}

interface PlaylistDetail {
	id: string;
	title: string;
	description: string | null;
	updatedAt?: string;
	tracks: PlaylistTrack[];
}

type SortOrder = "asc" | "desc";

export default function PlaylistDetailPage() {
	const params = useParams();
	const router = useRouter();
	// undefined = loading, null = not found.
	const [playlist, setPlaylist] = useState<PlaylistDetail | null | undefined>(undefined);
	const [editing, setEditing] = useState(false);
	const [deleting, setDeleting] = useState(false);
	const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
	const authLoading = useAuthStore((s) => s.isLoading);
	const loginHref = useLoginHref();
	const { prefs, updatePrefs } = useUserPreferences();
	const sortOrder: SortOrder = prefs.playlistSortOrder ?? "asc";
	const setSortOrder = (order: SortOrder) => updatePrefs({ playlistSortOrder: order });
	const currentPlayerTrack = usePlayerStore((s) => s.currentTrack);
	const stopPlayer = usePlayerStore((s) => s.stop);
	const playerPlay = usePlayerStore((s) => s.play);
	const toggleShuffle = usePlayerStore((s) => s.toggleShuffle);
	const filter = useTrackFilter();

	// Background prefetch: warm IndexedDB for the first tracks so playback starts instantly
	const allTrackIds = playlist?.tracks.map((t) => t.trackId) || [];
	usePrefetch(allTrackIds);

	useEffect(() => {
		if (!isAuthenticated || !params.id) return;
		let live = true;
		fetch(`/api/v1/playlists/${params.id}`)
			.then((res) => res.json())
			.then((json) => live && setPlaylist(json.success ? json.data : null))
			.catch(() => live && setPlaylist(null));
		return () => {
			live = false;
		};
	}, [params.id, isAuthenticated]);

	const loading = authLoading || (isAuthenticated && playlist === undefined);

	// Preload first tracks so playback starts instantly
	useEffect(() => {
		if (!playlist || playlist.tracks.length === 0) return;
		for (const track of playlist.tracks.slice(0, 3)) {
			preloadTrack(track.trackId);
		}
	}, [playlist]);

	const handleRemoveTrack = async (trackId: string) => {
		if (!playlist) return;
		const removed = playlist.tracks.find((t) => t.trackId === trackId);
		const before = [...playlist.tracks].sort((a, b) => a.position - b.position).map((t) => t.trackId);
		// Stop player if it's playing the track being removed
		if (currentPlayerTrack?.trackId === trackId) {
			stopPlayer();
		}
		try {
			await fetch(`/api/v1/playlists/${playlist.id}/tracks`, {
				method: "DELETE",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ trackIds: [trackId] }),
			});
			setPlaylist((prev) => (prev ? { ...prev, tracks: prev.tracks.filter((t) => t.trackId !== trackId) } : prev));
			if (removed) {
				toast(`Removed “${removed.title}”`, {
					action: { label: "Undo", onClick: () => void restoreTrack(playlist.id, removed, before) },
				});
			}
		} catch {
			// ignore
		}
	};

	/** Undo a removal: re-add the track, then put the old order back. */
	const restoreTrack = async (playlistId: string, track: PlaylistTrack, order: string[]) => {
		try {
			await fetch(`/api/v1/playlists/${playlistId}/tracks`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					tracks: [{ trackId: track.trackId, title: track.title, artist: track.artist, album: track.album, albumId: track.albumId ?? null, coverUrl: track.coverUrl, duration: track.duration }],
				}),
			});
			await fetch(`/api/v1/playlists/${playlistId}/tracks`, {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ trackIds: order }),
			});
			setPlaylist((prev) => {
				if (!prev || prev.tracks.some((t) => t.trackId === track.trackId)) return prev;
				const byId = new Map([...prev.tracks, track].map((t) => [t.trackId, t]));
				const tracks = order.map((id) => byId.get(id)).filter((t): t is PlaylistTrack => !!t).map((t, position) => ({ ...t, position }));
				return { ...prev, tracks };
			});
		} catch {
			toast.error("Couldn't restore the track");
		}
	};

	// Drag-reorder persistence: optimistic local update on every onReorder
	// (fires continuously during drag), but POST the final order to the API
	// debounced so we don't spam the endpoint mid-drag.
	const playlistId = playlist?.id ?? null;
	const [reorderSender] = useState(() =>
		trailingSend<{ pid: string; trackIds: string[] }>(({ pid, trackIds }, { leaving }) => {
			void fetch(`/api/v1/playlists/${pid}/tracks`, {
				method: "PATCH",
				// Leaving the page mid-wait: let the request outlive it.
				keepalive: leaving,
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ trackIds }),
			}).catch(() => {
				// Persist failed — leave the optimistic state in place. A future
				// fetch on mount will re-sync from the server.
			});
		}, 250)
	);
	// Leaving within the debounce (a link, Back) sends the last order instead of dropping it.
	useEffect(() => () => reorderSender.flush(), [reorderSender]);

	const handleReorder = useCallback((newOrderIds: string[]) => {
		// Optimistic local update — also rewrites .position so re-renders
		// in any sort order stay consistent until the API confirms.
		setPlaylist((prev) => {
			if (!prev) return prev;
			const byId = new Map(prev.tracks.map((t) => [t.trackId, t]));
			const next = newOrderIds
				.map((trackId, position) => {
					const t = byId.get(trackId);
					return t ? { ...t, position } : null;
				})
				.filter((t): t is PlaylistTrack => t !== null);
			return { ...prev, tracks: next };
		});

		// Debounce the API call until the drag settles (~250ms idle).
		if (playlistId) reorderSender.schedule({ pid: playlistId, trackIds: newOrderIds });
	}, [reorderSender, playlistId]);

	const saveDetails = async ({ title, description }: { title: string; description: string | null }) => {
		if (!playlist) return;
		const res = await fetch(`/api/v1/playlists/${playlist.id}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ title, description }),
		});
		const json = await res.json().catch(() => null);
		if (!res.ok || !json?.success) throw new Error(json?.error?.message || "Couldn't save the playlist");
		setPlaylist((prev) => (prev ? { ...prev, title, description, updatedAt: json.data?.updatedAt ?? new Date().toISOString() } : prev));
	};

	const deletePlaylist = async () => {
		if (!playlist) return;
		if (currentPlayerTrack && playlist.tracks.some((t) => t.trackId === currentPlayerTrack.trackId)) stopPlayer();
		const res = await fetch(`/api/v1/playlists/${playlist.id}`, { method: "DELETE" });
		if (!res.ok) {
			toast.error("Couldn't delete the playlist");
			return;
		}
		toast(`Deleted “${playlist.title}”`);
		// Replace: Back must not reopen the playlist that no longer exists.
		router.replace("/my-playlists");
	};

	if (loading) return <PlaylistDetailSkeleton />;

	// Signed out (or signed out here): never leave a private playlist on screen.
	if (!isAuthenticated) {
		return (
			<Medallion
				className="pt-[10vh]"
				icon={ListPlus}
				title="Sign in to open this playlist"
				message="Playlists are private to the account that made them."
				action={
					<Link href={loginHref} className={filledButton}>
						<LogIn />
						Sign in
					</Link>
				}
			/>
		);
	}

	if (!playlist) {
		return (
			<Medallion
				className="pt-[10vh]"
				icon={ListPlus}
				title="Playlist not found"
				message="It may have been deleted, or you don't have access to it."
				action={
					<Link href="/my-playlists" className={tonalButton}>
						<ArrowLeft />
						Back to playlists
					</Link>
				}
			/>
		);
	}

	const sortedTracks = [...playlist.tracks].sort((a, b) => (sortOrder === "asc" ? a.position - b.position : b.position - a.position));

	const playablePlaylistTracks: PlayerTrack[] = sortedTracks.map((t) => ({
		trackId: t.trackId,
		title: t.title,
		artist: t.artist,
		artistId: null,
		album: t.album,
		albumId: t.albumId ?? null,
		cover: t.coverUrl,
		duration: t.duration,
	}));

	const handlePlayAll = () => {
		if (playablePlaylistTracks.length === 0) return;
		playerPlay(playablePlaylistTracks[0], playablePlaylistTracks);
	};

	const handleShuffleAll = () => {
		if (playablePlaylistTracks.length === 0) return;
		const wasShuffled = usePlayerStore.getState().shuffle;
		if (!wasShuffled) toggleShuffle();
		playerPlay(playablePlaylistTracks[0], playablePlaylistTracks);
	};

	const normalized: TrackRowTrack[] = sortedTracks.map((track) => ({
		trackId: track.trackId,
		title: track.title,
		artist: track.artist,
		album: track.album,
		albumId: track.albumId ?? null,
		cover: track.coverUrl,
		duration: track.duration,
		bitrateLabel: null,
	}));

	// Searching shows a subset; numbers stay the tracks' places in the playlist.
	const rows = sortedTracks.map((track, i) => ({ track, row: normalized[i], number: i + 1 })).filter((r) => !filter.active || filter.match(r.track));

	// Drag-reorder is only correct when the display order matches the stored
	// position order (i.e. ascending) and every track is shown. In "newest
	// first" mode, dragging would invert positions on save — disable until the
	// user flips back to "asc" and clears the search.
	const reorderEnabled = sortOrder === "asc" && sortedTracks.length > 1 && !filter.active;
	const hint = filter.active ? "search" : reorderEnabled ? "drag" : sortedTracks.length > 1 ? "sort" : "few";
	const allCovers = uniqueCovers([[...playlist.tracks].sort((a, b) => a.position - b.position).map((t) => t.coverUrl)], 40);
	const seconds = playlist.tracks.reduce((s, t) => s + (t.duration ?? 0), 0);
	const updated = formatRelative(playlist.updatedAt);

	return (
		<>
			<CollectionScaffold
				title={playlist.title}
				covers={allCovers.slice(0, 4)}
				backdropCovers={allCovers}
				eyebrow="Playlist"
				stats={[
					{ icon: Music, label: plural(playlist.tracks.length, "track") },
					...(seconds > 0 ? [{ icon: Clock3, label: formatTotal(seconds) }] : []),
					...(updated ? [{ icon: History, label: `Updated ${updated === "Just now" ? "just now" : updated}` }] : []),
				]}
				description={playlist.description || undefined}
				trackIds={playablePlaylistTracks.map((t) => t.trackId)}
				onPlay={handlePlayAll}
				onShuffle={handleShuffleAll}
				playLabel="Play playlist"
				actions={
					<>
						<TonalIconButton label="Edit details" onClick={() => setEditing(true)}>
							<Pencil />
						</TonalIconButton>
						<DropdownMenu>
							<DropdownMenuTrigger
								aria-label="More options"
								title="More options"
								className="flex size-11 shrink-0 items-center justify-center rounded-full bg-secondary text-secondary-foreground outline-none transition-[background-color,transform] hover:bg-secondary/75 focus-visible:ring-4 focus-visible:ring-ring/40 active:scale-90"
							>
								<MoreHorizontal className="size-5" />
							</DropdownMenuTrigger>
							<DropdownMenuContent align="start" className="w-52 rounded-2xl p-1.5">
								<DropdownMenuItem className="gap-2.5 rounded-xl py-2" onClick={() => setEditing(true)}>
									<Pencil className="size-4" />
									Edit details
								</DropdownMenuItem>
								<DropdownMenuSeparator />
								<DropdownMenuItem variant="destructive" className="gap-2.5 rounded-xl py-2" onClick={() => setDeleting(true)}>
									<Trash2 className="size-4" />
									Delete playlist
								</DropdownMenuItem>
							</DropdownMenuContent>
						</DropdownMenu>
					</>
				}
			>
				<AnimatePresence mode="wait" initial={false}>
					{playlist.tracks.length === 0 ? (
						<motion.div key="empty" variants={swap} initial="initial" animate="animate" exit="exit">
							<Medallion
								icon={ListPlus}
								title="This playlist is empty"
								message="Add tracks from any track menu with “Add to playlist”."
								action={
									<Link href="/search" className={tonalButton}>
										<Search />
										Find tracks
									</Link>
								}
							/>
						</motion.div>
					) : (
						<motion.div key="list" variants={swap} initial="initial" animate="animate" exit="exit" className="mt-4">
							<div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-2">
								{sortedTracks.length > 1 && <TrackFilter value={filter.query} onChange={filter.setQuery} />}
								<AnimatePresence mode="wait" initial={false}>
									<motion.p
										key={hint}
										initial={{ opacity: 0, y: 6 }}
										animate={{ opacity: 1, y: 0 }}
										exit={{ opacity: 0, y: -6 }}
										transition={{ duration: 0.2 }}
										className="mr-auto flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground"
									>
										{hint === "drag" ? <GripVertical className="size-4 shrink-0 text-primary" /> : <ArrowDownUp className="size-4 shrink-0 text-primary" />}
										{hint === "search"
											? "Clear the search to reorder"
											: hint === "drag"
												? "Drag the handle to reorder"
												: hint === "sort"
													? "Switch to Oldest to reorder"
													: "Add more tracks to reorder"}
									</motion.p>
								</AnimatePresence>
								{sortedTracks.length > 1 && (
									<SlidingSegments<SortOrder>
										id="playlist-sort"
										size="sm"
										className="w-[200px]"
										value={sortOrder}
										onChange={setSortOrder}
										items={[
											{ value: "asc", label: "Oldest" },
											{ value: "desc", label: "Newest" },
										]}
									/>
								)}
							</div>
							{rows.length === 0 ? (
								<NoMatches query={filter.searched} />
							) : (
								<PlaylistTrackList rows={rows} queue={normalized} onReorder={handleReorder} onRemove={handleRemoveTrack} canDrag={reorderEnabled} />
							)}
						</motion.div>
					)}
				</AnimatePresence>
			</CollectionScaffold>

			<PlaylistEditDialog open={editing} onOpenChange={setEditing} mode="edit" initial={{ title: playlist.title, description: playlist.description }} onSubmit={saveDetails} />
			<DeletePlaylistDialog open={deleting} onOpenChange={setDeleting} title={playlist.title} trackCount={playlist.tracks.length} onConfirm={deletePlaylist} />
		</>
	);
}

/** The reorderable tracklist, virtualized once it grows long. Motion's
 *  Reorder swaps within the full `values`, so dragging among the mounted
 *  rows keeps the unmounted ones in place. */
function PlaylistTrackList({
	rows: items,
	queue,
	onReorder,
	onRemove,
	canDrag,
}: {
	/** The tracks shown (all of them, or the search results), with their place in the playlist. */
	rows: { track: PlaylistTrack; row: TrackRowTrack; number: number }[];
	/** The whole playlist, played from the tapped track. */
	queue: TrackRowTrack[];
	onReorder: (trackIds: string[]) => void;
	onRemove: (trackId: string) => void;
	canDrag: boolean;
}) {
	const { listRef, rows, measureRef, style } = useWindowRows({
		count: items.length,
		estimateSize: () => 60,
		getItemKey: (i) => items[i].track.id,
		gap: 2,
	});

	return (
		<Reorder.Group
			ref={listRef}
			as="div"
			axis="y"
			values={items.map((r) => r.track.trackId)}
			onReorder={onReorder}
			className="-mx-2 space-y-0.5"
			style={style}
		>
			{rows.map(({ index }) => (
				<DraggableRow
					key={items[index].track.id}
					measureRef={measureRef}
					trackId={items[index].track.trackId}
					idx={index}
					number={items[index].number}
					normalized={items[index].row}
					queue={queue}
					onDelete={() => onRemove(items[index].track.trackId)}
					canDrag={canDrag}
				/>
			))}
		</Reorder.Group>
	);
}

/** One reorderable row. Each instance owns a `useDragControls` so the drag
 *  surface stays scoped to the grip handle — touching the cover, title, or
 *  three-dot menu never starts a drag and never collides with long-press →
 *  TrackActionSheet on the underlying TrackRow. */
function DraggableRow({
	measureRef,
	trackId,
	idx,
	number,
	normalized,
	queue,
	onDelete,
	canDrag,
}: {
	measureRef?: (el: Element | null) => void;
	trackId: string;
	idx: number;
	number: number;
	normalized: TrackRowTrack;
	queue: TrackRowTrack[];
	onDelete: () => void;
	canDrag: boolean;
}) {
	const dragControls = useDragControls();

	return (
		<Reorder.Item
			ref={measureRef}
			data-index={idx}
			as="div"
			value={trackId}
			dragListener={false}
			dragControls={dragControls}
			exit={{ opacity: 0, x: -24, transition: { duration: 0.2 } }}
			whileDrag={{ scale: 1.02 }}
			className="relative flex items-stretch rounded-2xl bg-background data-[dragging=true]:z-10 data-[dragging=true]:bg-surface-high data-[dragging=true]:shadow-float"
		>
			<AnimatePresence initial={false}>
				{canDrag && (
					<motion.button
						type="button"
						aria-label={`Drag to reorder track ${number}`}
						initial={{ width: 0, opacity: 0 }}
						animate={{ width: "auto", opacity: 1 }}
						exit={{ width: 0, opacity: 0 }}
						transition={{ duration: 0.25, ease: [0.2, 0, 0, 1] }}
						onPointerDown={(e) => {
							e.preventDefault();
							dragControls.start(e);
						}}
						className="flex shrink-0 cursor-grab touch-none items-center justify-center overflow-hidden text-muted-foreground active:cursor-grabbing [@media(hover:hover)]:hover:text-primary"
					>
						<span className="flex w-9 justify-center md:w-8">
							<GripVertical className="size-4" aria-hidden />
						</span>
					</motion.button>
				)}
			</AnimatePresence>
			<div className="min-w-0 flex-1">
				<TrackRow track={normalized} trackNumber={number}showBitrate={false} showDuration onDelete={onDelete} queue={queue} />
			</div>
		</Reorder.Item>
	);
}
