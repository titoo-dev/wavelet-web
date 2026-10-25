"use client";

import { useState, useEffect, useCallback, type ReactNode } from "react";
import { motion, AnimatePresence } from "motion/react";
import { useTrackActionStore } from "@/stores/useTrackActionStore";
import { useAuthStore } from "@/stores/useAuthStore";
import { usePlayerStore } from "@/stores/usePlayerStore";
import { usePreviewStore } from "@/stores/usePreviewStore";
import { useShareStore } from "@/stores/useShareStore";
import { ShareDialog } from "./ShareDialog";
import { SaveButton } from "./SaveButton";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { Input } from "@/components/ui/input";
import { CoverImage } from "@/components/ui/cover-image";
import { ListEnd, ListPlus, ListStart, Trash2, Disc3, User, ArrowLeft, Plus, Share2, Link as LinkIcon, ChevronRight, Check, Radio } from "lucide-react";
import Link from "next/link";
import { Equalizer, PlayPauseIcon, Spinner } from "@/components/motion/icons";
import { Art, CoverTheme, entrance, swap, SPRING } from "@/components/expressive";
import { cn } from "@/lib/utils";
import { albumHref, artistHref, trackRadioHref } from "@/lib/entity-links";
import { ArtistLink, useOverlayLink } from "@/components/links/EntityLink";
import { leavePlayer } from "@/components/audio/leave-player";

function formatDuration(seconds?: number | null) {
	if (!seconds) return null;
	const m = Math.floor(seconds / 60);
	const s = Math.floor(seconds % 60);
	return `${m}:${s.toString().padStart(2, "0")}`;
}

interface Playlist {
	id: string;
	title: string;
	covers?: string[];
	_count?: { tracks: number };
	containsTrack?: boolean;
}

/** Add-to-playlist picker (the Flutter `showAddToPlaylist` sheet). */
function PlaylistPicker({ trackId, onBack }: { trackId: string; onBack: () => void }) {
	const [playlists, setPlaylists] = useState<Playlist[]>([]);
	const [loading, setLoading] = useState(true);
	const [addedTo, setAddedTo] = useState<Set<string>>(new Set());
	const [creating, setCreating] = useState(false);
	const [newName, setNewName] = useState("");
	const [submitting, setSubmitting] = useState(false);
	const track = useTrackActionStore((s) => s.track);

	useEffect(() => {
		async function load() {
			try {
				const res = await fetch(`/api/v1/playlists?trackId=${encodeURIComponent(trackId)}`, { credentials: "include" });
				const json = await res.json();
				if (json.success) {
					const data = json.data as Playlist[];
					setPlaylists(data);
					setAddedTo(new Set(data.filter((p) => p.containsTrack).map((p) => p.id)));
				}
			} catch {
				// ignore
			}
			setLoading(false);
		}
		load();
	}, [trackId]);

	const handleAdd = async (playlistId: string) => {
		if (!track || addedTo.has(playlistId)) return;
		try {
			const res = await fetch(`/api/v1/playlists/${playlistId}/tracks`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				credentials: "include",
				body: JSON.stringify({
					tracks: [
						{
							trackId: track.id,
							title: track.title,
							artist: track.artist,
							album: track.albumTitle || null,
							coverUrl: track.cover || null,
							duration: track.duration || null,
						},
					],
				}),
			});
			if (res.ok) {
				setAddedTo((prev) => new Set(prev).add(playlistId));
				if (navigator.vibrate) navigator.vibrate(30);
			}
		} catch {
			// ignore
		}
	};

	const handleCreate = async () => {
		const name = newName.trim();
		if (!name) return;
		setSubmitting(true);
		try {
			const res = await fetch("/api/v1/playlists", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				credentials: "include",
				body: JSON.stringify({ title: name }),
			});
			const json = await res.json();
			if (json.success) {
				const newPlaylist = json.data as Playlist;
				setPlaylists((prev) => [newPlaylist, ...prev]);
				await handleAdd(newPlaylist.id);
				setNewName("");
				setCreating(false);
			}
		} catch {
			// ignore
		}
		setSubmitting(false);
	};

	return (
		<div className="flex min-h-0 flex-col px-4 pb-2">
			<div className="flex items-center gap-2 pb-3">
				<button
					type="button"
					onClick={onBack}
					aria-label="Back"
					className="inline-flex size-10 items-center justify-center rounded-full bg-surface-high text-foreground transition-colors hover:bg-surface-highest active:scale-90"
				>
					<ArrowLeft className="size-[18px]" />
				</button>
				<h3 className="text-lg font-semibold tracking-tight">Add to playlist</h3>
			</div>

			{/* New playlist */}
			{creating ? (
				<form
					onSubmit={(e) => {
						e.preventDefault();
						handleCreate();
					}}
					className="flex items-center gap-2 rounded-[20px] bg-primary-container p-2 pl-3"
				>
					<Input
						autoFocus
						placeholder="Playlist name"
						value={newName}
						onChange={(e) => setNewName(e.target.value)}
						className="h-10 flex-1 rounded-full border-0 bg-surface-lowest"
					/>
					<button
						type="submit"
						disabled={!newName.trim() || submitting}
						className="inline-flex h-10 items-center justify-center rounded-full bg-primary px-4 text-sm font-semibold text-primary-foreground transition-opacity active:scale-95 disabled:opacity-50"
					>
						{submitting ? <Spinner size={14} /> : "Create"}
					</button>
				</form>
			) : (
				<motion.button
					type="button"
					whileTap={{ scale: 0.97 }}
					onClick={() => setCreating(true)}
					className="flex w-full items-center gap-3 rounded-[20px] bg-primary-container p-2 text-left text-on-primary-container"
				>
					<span className="flex size-12 items-center justify-center rounded-full bg-primary text-primary-foreground">
						<Plus className="size-6" />
					</span>
					<span className="text-[15px] font-semibold">New playlist</span>
				</motion.button>
			)}

			<div className="mt-2 max-h-[42vh] overflow-y-auto">
				{loading ? (
					<div className="space-y-1 py-1">
						{[0, 1, 2].map((i) => (
							<div key={i} className="flex items-center gap-3 p-2">
								<span className="size-12 animate-pulse rounded-[10px] bg-surface-high" />
								<span className="h-4 w-40 animate-pulse rounded-full bg-surface-high" />
							</div>
						))}
					</div>
				) : playlists.length === 0 ? (
					<p className="px-2 py-6 text-center text-sm text-muted-foreground">No playlists yet</p>
				) : (
					playlists.map((p, i) => {
						const added = addedTo.has(p.id);
						return (
							<motion.button
								key={p.id}
								{...entrance(i, 8)}
								type="button"
								onClick={() => handleAdd(p.id)}
								className="flex w-full items-center gap-3 rounded-2xl p-2 text-left transition-colors hover:bg-surface-high active:bg-surface-highest"
							>
								<Art covers={p.covers} className="size-12 shrink-0" rounded="rounded-[10px]" size={120} />
								<div className="min-w-0 flex-1">
									<p className="truncate text-[15px] font-semibold">{p.title}</p>
									{p._count?.tracks != null && (
										<p className="text-xs tabular-nums text-muted-foreground">
											{p._count.tracks} {p._count.tracks === 1 ? "track" : "tracks"}
										</p>
									)}
								</div>
								<AnimatePresence>
									{added && (
										<motion.span
											initial={{ scale: 0 }}
											animate={{ scale: 1 }}
											exit={{ scale: 0 }}
											transition={SPRING.pop}
											className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground"
										>
											<Check className="size-4" strokeWidth={3} />
										</motion.span>
									)}
								</AnimatePresence>
							</motion.button>
						);
					})
				)}
			</div>
		</div>
	);
}

/**
 * Track actions (the Flutter `showTrackActions` sheet): a cover-themed header
 * card, quick tiles, then settings-style rows. A bottom sheet on phones, a
 * floating sheet centred above the player on larger screens.
 */
export function TrackActionSheet() {
	const open = useTrackActionStore((s) => s.open);
	const track = useTrackActionStore((s) => s.track);
	const callbacks = useTrackActionStore((s) => s.callbacks);
	const closeSheet = useTrackActionStore((s) => s.closeSheet);
	const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
	const sharedMap = useShareStore((s) => s.shared);

	const previewTrack = usePreviewStore((s) => s.currentTrack);
	const previewPlaying = usePreviewStore((s) => s.isPlaying);
	const togglePreview = usePreviewStore((s) => s.toggle);

	const [view, setView] = useState<"actions" | "playlists">("actions");
	const [shareDialogOpen, setShareDialogOpen] = useState(false);

	// Reset the view whenever the sheet opens (adjusting state during render, not in an effect).
	const [wasOpen, setWasOpen] = useState(open);
	if (open !== wasOpen) {
		setWasOpen(open);
		if (open) setView("actions");
	}

	const currentPlayerTrack = usePlayerStore((s) => s.currentTrack);
	const playerPlaying = usePlayerStore((s) => s.isPlaying);
	const hasPlayerQueue = usePlayerStore((s) => s.queue.length > 0);

	const isPreviewActive = track && previewTrack?.id === track.id && previewPlaying;

	const handlePreview = useCallback(() => {
		if (!track?.previewUrl) return;
		togglePreview({
			id: track.id,
			title: track.title,
			artist: track.artist,
			artistId: track.artistId ?? null,
			cover: track.cover || "",
			previewUrl: track.previewUrl,
		});
	}, [track, togglePreview]);

	const toPlayerTrack = useCallback(() => {
		if (!track) return null;
		return {
			trackId: track.id,
			title: track.title,
			artist: track.artist,
			artistId: track.artistId ?? null,
			cover: track.cover ?? null,
			duration: track.duration ?? null,
		};
	}, [track]);

	const handlePlayNext = useCallback(() => {
		const pt = toPlayerTrack();
		if (!pt) return;
		usePlayerStore.getState().addNext(pt);
		closeSheet();
	}, [toPlayerTrack, closeSheet]);

	const handleAddToQueue = useCallback(() => {
		const pt = toPlayerTrack();
		if (!pt) return;
		usePlayerStore.getState().addToQueue(pt);
		closeSheet();
	}, [toPlayerTrack, closeSheet]);

	const handleDelete = useCallback(() => {
		callbacks.onDelete?.();
		closeSheet();
	}, [callbacks, closeSheet]);

	const isShared = track ? sharedMap.has(track.id) : false;

	const handleShare = useCallback(() => {
		if (!track) return;
		setShareDialogOpen(true);
	}, [track]);

	// Leaving for an artist / album page also drops Now Playing, the queue and lyrics if the sheet came from there
	// (one of them owns the current history entry); from a page, the player's panels stay as they are.
	const leave = () => {
		closeSheet();
		if (overlay.replace) leavePlayer();
	};
	const overlay = useOverlayLink(leave);

	if (!track) return null;

	const durationStr = formatDuration(track.duration);
	const isCurrent = currentPlayerTrack?.trackId === track.id;
	const canQueue = hasPlayerQueue && !isCurrent;

	const tiles: { key: string; label: string; aria: string; icon: ReactNode; onClick: () => void; on?: boolean }[] = [];
	if (track.previewUrl)
		tiles.push({
			key: "preview",
			label: "Preview",
			aria: isPreviewActive ? "Pause preview" : "Play preview",
			icon: <PlayPauseIcon playing={!!isPreviewActive} className="size-6" />,
			onClick: handlePreview,
			on: !!isPreviewActive,
		});
	if (canQueue) {
		tiles.push({ key: "next", label: "Play next", aria: "Play next", icon: <ListStart />, onClick: handlePlayNext });
		tiles.push({ key: "queue", label: "Queue", aria: "Add to queue", icon: <ListEnd />, onClick: handleAddToQueue });
	}
	if (isAuthenticated) {
		tiles.push({ key: "playlist", label: "Playlist", aria: "Add to playlist", icon: <ListPlus />, onClick: () => setView("playlists") });
		tiles.push({
			key: "share",
			label: "Share",
			aria: isShared ? "Manage share link" : "Share track",
			icon: isShared ? <LinkIcon /> : <Share2 />,
			onClick: handleShare,
			on: isShared,
		});
	}

	const albumLink = albumHref(track.albumId, track.albumTitle, track.artist);
	const artistLink = artistHref(track.artistId, track.artist);
	const radioLink = isAuthenticated ? trackRadioHref(track.id) : null;
	const rows: ReactNode[] = [];
	if (radioLink)
		rows.push(
			<Link key="radio" href={radioLink} replace={overlay.replace} onClick={overlay.onClick} className="no-underline">
				<ActionRow icon={<Radio />} label="Go to song radio" sublabel="Discover songs that sound like it" chevron />
			</Link>
		);
	if (albumLink)
		rows.push(
			<Link key="album" href={albumLink} replace={overlay.replace} onClick={overlay.onClick} className="no-underline">
				<ActionRow icon={<Disc3 />} label="Go to album" sublabel={track.albumTitle || undefined} chevron />
			</Link>
		);
	if (artistLink)
		rows.push(
			<Link key="artist" href={artistLink} replace={overlay.replace} onClick={overlay.onClick} className="no-underline">
				<ActionRow icon={<User />} label="Go to artist" sublabel={track.artist} chevron />
			</Link>
		);
	if (callbacks.onDelete) rows.push(<ActionRow key="delete" icon={<Trash2 />} label="Remove from playlist" onClick={handleDelete} destructive />);

	return (
		<>
			<Sheet open={open} onOpenChange={(o) => !o && closeSheet()}>
				<SheetContent
					side="bottom"
					showCloseButton={false}
					className="max-h-[88vh] gap-0 overflow-hidden rounded-t-[28px] border-0 bg-surface-low pb-[max(1rem,env(safe-area-inset-bottom))] data-[side=bottom]:border-t-0 md:inset-x-0 md:bottom-6 md:mx-auto md:max-w-[460px] md:rounded-[28px]"
				>
					<CoverTheme src={track.cover} className="flex min-h-0 flex-col">
						<div aria-hidden className="mx-auto mb-1 mt-2.5 h-1 w-9 shrink-0 rounded-full bg-foreground/20" />

						{/* Header card */}
						<SheetHeader className="px-4 pb-3 pt-2">
							<div className="flex items-center gap-4 rounded-[28px] bg-[linear-gradient(135deg,var(--m3-primary-container),var(--m3-surface-container-high))] p-3.5">
								<CoverImage
									src={track.cover}
									className="size-[84px] shrink-0 rounded-[18px] shadow-[0_10px_24px_-8px_color-mix(in_oklch,var(--primary)_55%,transparent)]"
								/>
								<div className="min-w-0 flex-1">
									<SheetTitle className="line-clamp-2 text-[22px] font-semibold leading-[1.15] tracking-[-0.02em] text-foreground">
										{track.title}
									</SheetTitle>
									<SheetDescription className="mt-0.5 truncate text-sm font-semibold text-muted-foreground">
										<ArtistLink id={track.artistId} name={track.artist} onClick={leave} className="transition-colors hover:text-foreground" />
									</SheetDescription>
									{(isCurrent || durationStr) && (
										<div className="mt-2 flex flex-wrap gap-1.5">
											{isCurrent && (
												<span className="inline-flex h-6 items-center gap-1.5 rounded-full bg-primary px-2.5 text-[11px] font-semibold text-primary-foreground">
													{playerPlaying && <Equalizer playing className="h-2.5" />}
													Playing
												</span>
											)}
											{durationStr && (
												<span className="inline-flex h-6 items-center rounded-full bg-surface-lowest/70 px-2.5 text-[11px] font-semibold tabular-nums text-foreground/80">
													{durationStr}
												</span>
											)}
										</div>
									)}
								</div>
								{isAuthenticated && (
									<SaveButton
										variant="tonal"
										track={{
											trackId: track.id,
											title: track.title,
											artist: track.artist,
											album: track.albumTitle ?? null,
											albumId: track.albumId ?? null,
											coverUrl: track.cover ?? null,
											duration: track.duration ?? null,
										}}
										className="self-start"
									/>
								)}
							</div>
						</SheetHeader>

						<AnimatePresence mode="wait" initial={false}>
							{view === "actions" ? (
								<motion.div key="actions" variants={swap} initial="initial" animate="animate" exit="exit" className="flex flex-col gap-3 px-4 pb-1">
									{tiles.length > 0 && (
										<div className="grid gap-2" style={{ gridTemplateColumns: `repeat(${Math.min(tiles.length, 5)}, minmax(0, 1fr))` }}>
											{tiles.map((t, i) => (
												<motion.button
													key={t.key}
													{...entrance(i, 10)}
													type="button"
													aria-label={t.aria}
													onClick={t.onClick}
													whileTap={{ scale: 0.94 }}
													className={cn(
														"flex flex-col items-center justify-center gap-1.5 rounded-[20px] px-1 py-3.5 outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/40 [&_svg]:size-6",
														t.on ? "bg-primary text-primary-foreground" : "bg-secondary text-secondary-foreground hover:bg-secondary/80"
													)}
												>
													{t.icon}
													<span className="truncate text-xs font-semibold">{t.label}</span>
												</motion.button>
											))}
										</div>
									)}

									{rows.length > 0 && <div className="flex flex-col overflow-hidden rounded-[24px] bg-surface-container p-1">{rows}</div>}
								</motion.div>
							) : (
								<motion.div key="playlists" variants={swap} initial="initial" animate="animate" exit="exit" className="flex min-h-0 flex-col">
									<PlaylistPicker trackId={track.id} onBack={() => setView("actions")} />
								</motion.div>
							)}
						</AnimatePresence>
					</CoverTheme>
				</SheetContent>
			</Sheet>

			{track && (
				<ShareDialog
					open={shareDialogOpen}
					onOpenChange={setShareDialogOpen}
					trackId={track.id}
					duration={track.duration}
					title={track.title}
					artist={track.artist}
					album={track.albumTitle ?? null}
					cover={track.cover ?? null}
					onShared={closeSheet}
				/>
			)}
		</>
	);
}

/** Settings-style row: tonal icon well, label + sublabel, optional chevron. */
function ActionRow({
	icon,
	label,
	sublabel,
	onClick,
	chevron,
	destructive,
}: {
	icon: ReactNode;
	label: ReactNode;
	sublabel?: string;
	onClick?: () => void;
	chevron?: boolean;
	destructive?: boolean;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			className={cn(
				"flex w-full items-center gap-3.5 rounded-[20px] px-2.5 py-2 text-left transition-colors active:scale-[0.99]",
				destructive ? "text-destructive hover:bg-destructive/10" : "text-foreground hover:bg-surface-high"
			)}
		>
			<span
				className={cn(
					"flex size-10 shrink-0 items-center justify-center rounded-full [&_svg]:size-5",
					destructive ? "bg-destructive/12 text-destructive" : "bg-surface-highest text-primary"
				)}
			>
				{icon}
			</span>
			<div className="min-w-0 flex-1">
				<p className="truncate text-[15px] font-semibold">{label}</p>
				{sublabel && <p className="truncate text-xs text-muted-foreground">{sublabel}</p>}
			</div>
			{chevron && <ChevronRight className="size-[18px] shrink-0 text-muted-foreground" />}
		</button>
	);
}
