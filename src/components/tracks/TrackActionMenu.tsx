"use client";

import { useState, useEffect, useCallback } from "react";
import { useAuthStore } from "@/stores/useAuthStore";
import { usePlayerStore } from "@/stores/usePlayerStore";
import { usePreviewStore } from "@/stores/usePreviewStore";
import { useShareStore } from "@/stores/useShareStore";
import { useSavedTracks } from "@/hooks/useLibrary";
import { ShareDialog } from "./ShareDialog";
import {
	DropdownMenu,
	DropdownMenuTrigger,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import {
	ArrowLeft,
	ListEnd,
	ListPlus,
	ListStart,
	Trash2,
	Disc3,
	User,
	Share2,
	Link as LinkIcon,
	MoreHorizontal,
	ChevronRight,
	Plus,
	Radio,
} from "lucide-react";
import Link from "next/link";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { DrawCheck, HeartGlyph, PlayPauseIcon, Spinner } from "@/components/motion/icons";
import { CoverImage } from "@/components/ui/cover-image";
import { cn } from "@/lib/utils";
import { albumHref, artistHref, trackRadioHref } from "@/lib/entity-links";
import { ArtistLink } from "@/components/links/EntityLink";

/** Menu item shape: rounded-xl rows with a little more air (M3 menus). */
const item = "gap-2.5 rounded-xl px-2.5 py-2 [&_svg:not([class*='text-'])]:text-muted-foreground";

export interface TrackActionTrack {
	id: string;
	title: string;
	artist: string;
	cover?: string;
	duration?: number;
	albumId?: string;
	albumTitle?: string;
	artistId?: string;
	previewUrl?: string;
}

export interface TrackActionCallbacks {
	/** Removal callback for context-specific deletes (e.g. remove from a playlist). */
	onDelete?: () => void;
}

interface Playlist {
	id: string;
	title: string;
	_count?: { tracks: number };
	containsTrack?: boolean;
}

function AddToPlaylistSubmenu({
	track,
	onClose,
}: {
	track: TrackActionTrack;
	onClose: () => void;
}) {
	const [playlists, setPlaylists] = useState<Playlist[]>([]);
	const [loading, setLoading] = useState(true);
	const [addedTo, setAddedTo] = useState<Set<string>>(new Set());
	const [creating, setCreating] = useState(false);
	const [newName, setNewName] = useState("");
	const [submitting, setSubmitting] = useState(false);

	useEffect(() => {
		(async () => {
			try {
				const res = await fetch(
					`/api/v1/playlists?trackId=${encodeURIComponent(track.id)}`,
					{ credentials: "include" },
				);
				const json = await res.json();
				if (json.success) {
					const data = json.data as Playlist[];
					setPlaylists(data);
					setAddedTo(
						new Set(data.filter((p) => p.containsTrack).map((p) => p.id)),
					);
				}
			} catch {
				// ignore
			}
			setLoading(false);
		})();
	}, [track.id]);

	const addTrackToPlaylist = async (playlistId: string) => {
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
						albumId: track.albumId || null,
						coverUrl: track.cover || null,
						duration: track.duration || null,
					},
				],
			}),
		});
		return res.ok;
	};

	const handleAdd = async (playlistId: string) => {
		if (addedTo.has(playlistId)) return;
		try {
			if (await addTrackToPlaylist(playlistId)) {
				setAddedTo((prev) => new Set(prev).add(playlistId));
				setTimeout(onClose, 600);
			}
		} catch {
			// ignore
		}
	};

	const handleCreate = async () => {
		const name = newName.trim();
		if (!name || submitting) return;
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
				const created = json.data as Playlist;
				setPlaylists((prev) => [created, ...prev]);
				if (await addTrackToPlaylist(created.id)) {
					setAddedTo((prev) => new Set(prev).add(created.id));
					setTimeout(onClose, 600);
				}
				setNewName("");
				setCreating(false);
			}
		} catch {
			// ignore
		}
		setSubmitting(false);
	};

	return (
		<div className="flex flex-col">
			{loading ? (
				<div className="px-3 py-3 flex items-center justify-center">
					<Spinner className="text-muted-foreground" />
				</div>
			) : playlists.length === 0 && !creating ? (
				<div className="px-2 py-2 text-sm text-muted-foreground">
					No playlists yet
				</div>
			) : (
				<div className="max-h-[40vh] overflow-y-auto">
					{playlists.map((p) => {
						const inPlaylist = addedTo.has(p.id);
						return (
							<DropdownMenuItem
								key={p.id}
								closeOnClick={false}
								onClick={() => handleAdd(p.id)}
								className="flex items-center justify-between gap-3 rounded-xl px-2.5 py-2"
							>
								<span className="truncate">{p.title}</span>
								{inPlaylist ? (
									<DrawCheck className="size-4 shrink-0 text-primary" />
								) : (
									<span className="font-mono text-xs tabular-nums text-muted-foreground shrink-0">
										{p._count?.tracks ?? 0}
									</span>
								)}
							</DropdownMenuItem>
						);
					})}
				</div>
			)}

			{creating ? (
				<form
					onSubmit={(e) => {
						e.preventDefault();
						handleCreate();
					}}
					onClick={(e) => e.stopPropagation()}
					// Keys stop here (capture) so the menu's typeahead / dismiss never see them — which
					// also means the field's own handlers never run: Escape is handled right here
					// (was: an onKeyDown on the Input that the capture stop made dead code).
					onKeyDownCapture={(e) => {
						e.stopPropagation();
						if (e.key === "Escape") {
							e.preventDefault();
							setCreating(false);
							setNewName("");
						}
					}}
					className="-mx-1 mt-1 flex items-center gap-2 border-t border-border px-2 pt-2 pb-1"
				>
					<Input
						autoFocus
						placeholder="Playlist name"
						value={newName}
						onChange={(e) => setNewName(e.target.value)}
						className="flex-1 h-8 text-[13px]"
					/>
					<Button
						type="submit"
						size="sm"
						disabled={!newName.trim() || submitting}
						className="h-8"
					>
						{submitting ? <Spinner size={14} /> : "Create"}
					</Button>
				</form>
			) : (
				<>
					<DropdownMenuSeparator />
					<DropdownMenuItem
						closeOnClick={false}
						onClick={() => setCreating(true)}
						className="gap-2.5 rounded-xl px-2.5 py-2 font-semibold text-primary focus:text-primary"
					>
						<span className="flex size-6 items-center justify-center rounded-full bg-primary text-primary-foreground">
							<Plus className="size-3.5" />
						</span>
						<span>New playlist</span>
					</DropdownMenuItem>
				</>
			)}
		</div>
	);
}

interface TrackActionMenuProps {
	track: TrackActionTrack;
	callbacks?: TrackActionCallbacks;
	side?: "top" | "right" | "bottom" | "left";
	align?: "start" | "center" | "end";
	className?: string;
}

export function TrackActionMenu({
	track,
	callbacks = {},
	side = "bottom",
	align = "end",
	className = "",
}: TrackActionMenuProps) {
	const [open, setOpen] = useState(false);
	const [view, setView] = useState<"main" | "playlists">("main");
	const [shareDialogOpen, setShareDialogOpen] = useState(false);

	const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
	const sharedMap = useShareStore((s) => s.shared);
	const isShared = sharedMap.has(track.id);

	const { isSaved, save, unsave } = useSavedTracks(
		isAuthenticated ? [track.id] : []
	);
	const saved = isSaved(track.id);

	const previewTrack = usePreviewStore((s) => s.currentTrack);
	const previewPlaying = usePreviewStore((s) => s.isPlaying);
	const togglePreview = usePreviewStore((s) => s.toggle);
	const isPreviewActive = previewTrack?.id === track.id && previewPlaying;

	const currentPlayerTrack = usePlayerStore((s) => s.currentTrack);
	const hasPlayerQueue = usePlayerStore((s) => s.queue.length > 0);

	// Back to the main view whenever the menu closes.
	const changeOpen = (next: boolean) => {
		setOpen(next);
		if (!next) setView("main");
	};
	const close = () => changeOpen(false);
	const albumLink = albumHref(track.albumId, track.albumTitle, track.artist);
	const artistLink = artistHref(track.artistId, track.artist);
	const radioLink = isAuthenticated ? trackRadioHref(track.id) : null;

	const toPlayerTrack = useCallback(
		() => ({
			trackId: track.id,
			title: track.title,
			artist: track.artist,
			artistId: track.artistId ?? null,
			cover: track.cover ?? null,
			duration: track.duration ?? null,
		}),
		[track]
	);

	const handlePreview = () => {
		if (!track.previewUrl) return;
		togglePreview({
			id: track.id,
			title: track.title,
			artist: track.artist,
			artistId: track.artistId ?? null,
			cover: track.cover || "",
			previewUrl: track.previewUrl,
		});
		close();
	};

	const handlePlayNext = () => {
		usePlayerStore.getState().addNext(toPlayerTrack());
		close();
	};

	const handleAddToQueue = () => {
		usePlayerStore.getState().addToQueue(toPlayerTrack());
		close();
	};

	const handleSave = async () => {
		try {
			if (saved) {
				await unsave(track.id);
			} else {
				await save({
					trackId: track.id,
					title: track.title,
					artist: track.artist,
					album: track.albumTitle ?? null,
					albumId: track.albumId ?? null,
					coverUrl: track.cover ?? null,
					duration: track.duration ?? null,
				});
			}
		} catch {
			// optimistic update will revert on its own
		}
		close();
	};

	const handleDelete = () => {
		callbacks.onDelete?.();
		close();
	};

	const handleShare = () => {
		setShareDialogOpen(true);
		close();
	};

	return (
		<>
			<DropdownMenu open={open} onOpenChange={changeOpen}>
				<DropdownMenuTrigger
					render={
						<button
							onClick={(e) => e.stopPropagation()}
							onMouseDown={(e) => e.stopPropagation()}
							onPointerDown={(e) => e.stopPropagation()}
							aria-label="Track actions"
							className={cn("inline-flex size-8 shrink-0 items-center justify-center rounded-full text-muted-foreground outline-none transition-[color,background-color,scale] hover:bg-surface-highest hover:text-foreground active:scale-90 focus-visible:ring-[3px] focus-visible:ring-ring/30 data-popup-open:bg-secondary data-popup-open:text-secondary-foreground", className)}
						/>
					}
				>
					<MoreHorizontal className="size-4" />
				</DropdownMenuTrigger>
				<DropdownMenuContent
					side={side}
					align={align}
					className="w-72 rounded-2xl p-1.5"
					onClick={(e) => e.stopPropagation()}
				>
					{view === "main" ? (
						<div>
							{/* Track header */}
							<div className="mb-1 flex items-center gap-3 rounded-xl bg-[linear-gradient(135deg,var(--m3-primary-container),var(--m3-surface-container-high))] p-2">
								<CoverImage src={track.cover ?? null} className="size-11 shrink-0 rounded-[10px]" />
								<div className="min-w-0">
									<p className="truncate text-sm font-semibold leading-tight tracking-[-0.01em]">{track.title}</p>
									<p className="mt-0.5 truncate text-xs text-muted-foreground">
										<ArtistLink id={track.artistId} name={track.artist} onClick={close} className="transition-colors hover:text-foreground" />
									</p>
								</div>
							</div>

							{track.previewUrl && (
								<DropdownMenuItem onClick={handlePreview} className={item}>
									<PlayPauseIcon playing={isPreviewActive} />
									{isPreviewActive ? "Pause preview" : "Play preview"}
								</DropdownMenuItem>
							)}

							{hasPlayerQueue && currentPlayerTrack?.trackId !== track.id && (
								<>
									<DropdownMenuItem onClick={handlePlayNext} className={item}>
										<ListStart className="size-4" />
										Play next
									</DropdownMenuItem>
									<DropdownMenuItem onClick={handleAddToQueue} className={item}>
										<ListEnd className="size-4" />
										Add to queue
									</DropdownMenuItem>
								</>
							)}

							{isAuthenticated && (
								<DropdownMenuItem onClick={handleSave} className={item}>
									<HeartGlyph filled={saved} className={saved ? "!text-primary" : ""} />
									{saved ? "Remove from library" : "Save to library"}
								</DropdownMenuItem>
							)}

							{isAuthenticated && (
								<DropdownMenuItem
									className={item}
									closeOnClick={false}
									onClick={() => setView("playlists")}
								>
									<ListPlus className="size-4" />
									<span className="flex-1">Add to playlist</span>
									<ChevronRight className="size-3.5 text-muted-foreground" />
								</DropdownMenuItem>
							)}

							{isAuthenticated && (
								<DropdownMenuItem onClick={handleShare} className={item}>
									{isShared ? <LinkIcon className="size-4 !text-primary" /> : <Share2 className="size-4" />}
									{isShared ? "Manage share" : "Share track"}
								</DropdownMenuItem>
							)}

							{(radioLink || albumLink || artistLink) && <DropdownMenuSeparator />}

							{radioLink && (
								<Link href={radioLink} onClick={close} className="no-underline">
									<DropdownMenuItem className={item}>
										<Radio className="size-4" />
										Go to song radio
									</DropdownMenuItem>
								</Link>
							)}

							{albumLink && (
								<Link href={albumLink} onClick={close} className="no-underline">
									<DropdownMenuItem className={item}>
										<Disc3 className="size-4" />
										<span className="truncate">{track.albumTitle || "Go to album"}</span>
									</DropdownMenuItem>
								</Link>
							)}

							{artistLink && (
								<Link href={artistLink} onClick={close} className="no-underline">
									<DropdownMenuItem className={item}>
										<User className="size-4" />
										<span className="truncate">{track.artist}</span>
									</DropdownMenuItem>
								</Link>
							)}

							{callbacks.onDelete && (
								<>
									<DropdownMenuSeparator />
									<DropdownMenuItem
										onClick={handleDelete}
										className="gap-2.5 rounded-xl px-2.5 py-2 text-destructive focus:bg-destructive/10 focus:text-destructive"
									>
										<Trash2 className="size-4" />
										Remove
									</DropdownMenuItem>
								</>
							)}
						</div>
					) : (
						<div>
							<div className="mb-1 flex items-center gap-2 px-1 py-1">
								<button
									onClick={(e) => {
										e.preventDefault();
										setView("main");
									}}
									aria-label="Back"
									className="inline-flex size-8 items-center justify-center rounded-full bg-surface-high text-foreground outline-none transition-colors hover:bg-surface-highest focus-visible:ring-[3px] focus-visible:ring-ring/30"
								>
									<ArrowLeft className="size-4" />
								</button>
								<span className="text-sm font-semibold tracking-tight">Add to playlist</span>
							</div>
							<AddToPlaylistSubmenu track={track} onClose={close} />
						</div>
					)}
				</DropdownMenuContent>
			</DropdownMenu>

			<ShareDialog
				open={shareDialogOpen}
				onOpenChange={setShareDialogOpen}
				trackId={track.id}
				duration={track.duration}
				title={track.title}
				artist={track.artist}
				album={track.albumTitle ?? null}
				cover={track.cover ?? null}
			/>
		</>
	);
}
