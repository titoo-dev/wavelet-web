"use client";

import { useEffect, useRef } from "react";
import { MoreVertical } from "lucide-react";
import { toast } from "sonner";
import { CoverImage } from "@/components/ui/cover-image";
import { PlaybackIndicator } from "@/components/audio/PlaybackIndicator";
import { DownloadGlyph, PlayPauseIcon } from "@/components/motion/icons";
import { useDownloadStore } from "@/stores/useDownloadStore";
import { useAuthStore } from "@/stores/useAuthStore";
import { warmTrack } from "@/components/audio/AudioEngine";
import { SaveButton } from "@/components/tracks/SaveButton";
import { TrackActionMenu } from "@/components/tracks/TrackActionMenu";
import { useLongPress } from "@/hooks/useLongPress";
import { useTrackActionStore } from "@/stores/useTrackActionStore";
import { usePreviewStore } from "@/stores/usePreviewStore";
import { usePlayerStore, type PlayerTrack } from "@/stores/usePlayerStore";
import { convertDuration } from "@/utils/helpers";
import { getBitrateBadge } from "@/utils/track-format";
import type { GwResults } from "@/lib/deezer/gw";
import { AlbumLink, ArtistLink } from "@/components/links/EntityLink";

export interface TrackRowTrack {
	trackId: string;
	title: string;
	artist: string;
	artistId?: string | null;
	album?: string | null;
	albumId?: string | null;
	cover: string | null;
	duration?: number | null;
	previewUrl?: string | null;
	/** Pre-computed bitrate label (e.g. "FLAC", "320"). When omitted, the cell is hidden. */
	bitrateLabel?: string | null;
	/** Carried to the player (PlayerTrack.source), e.g. "daily-mix". */
	source?: string | null;
}

export interface TrackRowProps {
	track: TrackRowTrack;
	showBitrate?: boolean;
	showDuration?: boolean;
	/** Show the Save (heart) button. Default true. */
	showSave?: boolean;
	/** Context-specific delete callback (e.g. remove from a playlist). */
	onDelete?: () => void;
	/** When set, prepends a "#" column with the track number (album/playlist view). */
	trackNumber?: number;
	/**
	 * Surrounding tracks to enqueue when this row is played. Pass the full
	 * displayed list (in display order) so playback chains through. When
	 * omitted, only this track plays.
	 */
	queue?: TrackRowTrack[];
	/** Show the artwork column (default true). Without it the number cell doubles as the play button. */
	showCover?: boolean;
	/** Overrides the default "artist · album" subtitle. */
	subtitle?: React.ReactNode;
}

// Literal class strings so Tailwind picks them up. Key: number · cover · bitrate · duration.
const GRID: Record<string, string> = {
	"0000": "grid-cols-[minmax(0,1fr)_auto] sm:grid-cols-[minmax(0,1fr)_auto]",
	"0001": "grid-cols-[minmax(0,1fr)_auto] sm:grid-cols-[minmax(0,1fr)_52px_auto]",
	"0010": "grid-cols-[minmax(0,1fr)_auto_auto] sm:grid-cols-[minmax(0,1fr)_auto_auto]",
	"0011": "grid-cols-[minmax(0,1fr)_auto_auto] sm:grid-cols-[minmax(0,1fr)_auto_52px_auto]",
	"0100": "grid-cols-[48px_minmax(0,1fr)_auto] sm:grid-cols-[48px_minmax(0,1fr)_auto]",
	"0101": "grid-cols-[48px_minmax(0,1fr)_auto] sm:grid-cols-[48px_minmax(0,1fr)_52px_auto]",
	"0110": "grid-cols-[48px_minmax(0,1fr)_auto_auto] sm:grid-cols-[48px_minmax(0,1fr)_auto_auto]",
	"0111": "grid-cols-[48px_minmax(0,1fr)_auto_auto] sm:grid-cols-[48px_minmax(0,1fr)_auto_52px_auto]",
	"1000": "grid-cols-[28px_minmax(0,1fr)_auto] sm:grid-cols-[28px_minmax(0,1fr)_auto]",
	"1001": "grid-cols-[28px_minmax(0,1fr)_auto] sm:grid-cols-[28px_minmax(0,1fr)_52px_auto]",
	"1010": "grid-cols-[28px_minmax(0,1fr)_auto_auto] sm:grid-cols-[28px_minmax(0,1fr)_auto_auto]",
	"1011": "grid-cols-[28px_minmax(0,1fr)_auto_auto] sm:grid-cols-[28px_minmax(0,1fr)_auto_52px_auto]",
	"1100": "grid-cols-[28px_48px_minmax(0,1fr)_auto] sm:grid-cols-[28px_48px_minmax(0,1fr)_auto]",
	"1101": "grid-cols-[28px_48px_minmax(0,1fr)_auto] sm:grid-cols-[28px_48px_minmax(0,1fr)_52px_auto]",
	"1110": "grid-cols-[28px_48px_minmax(0,1fr)_auto_auto] sm:grid-cols-[28px_48px_minmax(0,1fr)_auto_auto]",
	"1111": "grid-cols-[28px_48px_minmax(0,1fr)_auto_auto] sm:grid-cols-[28px_48px_minmax(0,1fr)_auto_52px_auto]",
};

/**
 * Convert a raw Deezer GW/API track into the normalized TrackRowTrack shape
 * used by this component. Handles both the GW (SNG_ID, ART_NAME, ALB_PICTURE)
 * and public API (id, artist.name, album.cover_small) variants.
 */
export function trackFromDeezerRaw(raw: GwResults): TrackRowTrack {
	const id = raw.SNG_ID || raw.id;
	const cover =
		raw.album?.cover_small ||
		(raw.ALB_PICTURE
			? `https://e-cdns-images.dzcdn.net/images/cover/${raw.ALB_PICTURE}/56x56-000000-80-0-0.jpg`
			: null);
	const previewUrl = (raw.MEDIA?.[0]?.HREF || raw.preview || "").replace(
		"http://",
		"https://"
	);
	return {
		trackId: String(id),
		title: raw.SNG_TITLE || raw.title || "",
		artist: raw.ART_NAME || raw.artist?.name || "",
		artistId: raw.ART_ID || raw.artist?.id || null,
		album: raw.ALB_TITLE || raw.album?.title || null,
		albumId: raw.ALB_ID || raw.album?.id || null,
		cover,
		duration: raw.DURATION ? Number(raw.DURATION) : raw.duration ?? null,
		previewUrl: previewUrl || null,
		bitrateLabel: getBitrateBadge(raw),
	};
}

export function TrackRow({
	track,
	showBitrate = true,
	showDuration = true,
	showSave = true,
	onDelete,
	trackNumber,
	queue,
	showCover = true,
	subtitle,
}: TrackRowProps) {
	const previewTrack = usePreviewStore((s) => s.currentTrack);
	const previewPlaying = usePreviewStore((s) => s.isPlaying);
	const playerTrack = usePlayerStore((s) => s.currentTrack);
	const playerPlaying = usePlayerStore((s) => s.isPlaying);
	const playerPlay = usePlayerStore((s) => s.play);
	const playerToggle = usePlayerStore((s) => s.toggle);

	const isPreviewActive = previewTrack?.id === track.trackId && previewPlaying;
	const isPlayerActive = playerTrack?.trackId === track.trackId && playerPlaying;
	const isPlayerLoaded = playerTrack?.trackId === track.trackId;
	const isActive = isPreviewActive || isPlayerActive;
	const isPaused =
		(previewTrack?.id === track.trackId && !previewPlaying) ||
		(playerTrack?.trackId === track.trackId && !playerPlaying);

	const handlePlay = (e: React.MouseEvent | React.TouchEvent) => {
		e.stopPropagation();
		e.preventDefault();
		if (isPlayerLoaded) {
			playerToggle();
			return;
		}
		const tapped: PlayerTrack = {
			trackId: track.trackId,
			title: track.title,
			artist: track.artist,
			artistId: track.artistId ?? null,
			album: track.album ?? null,
			albumId: track.albumId ?? null,
			cover: track.cover,
			duration: track.duration ?? null,
			...(track.source ? { source: track.source } : {}),
		};
		if (queue && queue.length > 0) {
			const mapped: PlayerTrack[] = queue.map((t) => ({
				trackId: t.trackId,
				title: t.title,
				artist: t.artist,
				artistId: t.artistId ?? null,
				album: t.album ?? null,
				albumId: t.albumId ?? null,
				cover: t.cover,
				duration: t.duration ?? null,
				...(t.source ? { source: t.source } : {}),
			}));
			// Ensure the tapped track is in the queue. If callers passed a list
			// that excludes the tapped track for some reason, fall back gracefully.
			const inQueue = mapped.some((t) => t.trackId === tapped.trackId);
			playerPlay(tapped, inQueue ? mapped : [tapped, ...mapped]);
			return;
		}
		playerPlay(tapped);
	};

	const enqueueDownload = useDownloadStore((s) => s.enqueue);
	const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
	const handleDownload = (e: React.MouseEvent) => {
		e.stopPropagation();
		if (!isAuthenticated) {
			toast("Sign in to download");
			return;
		}
		const n = enqueueDownload([
			{
				trackId: track.trackId,
				title: track.title,
				artist: track.artist,
				album: track.album ?? null,
				cover: track.cover,
				duration: track.duration ?? null,
			},
		]);
		toast(n ? `Downloading “${track.title}”` : "Already downloading");
	};

	const openSheet = useTrackActionStore((s) => s.openSheet);
	const callbacks = onDelete ? { onDelete } : undefined;
	const longPress = useLongPress(() => {
		openSheet(
			{
				id: track.trackId,
				title: track.title,
				artist: track.artist,
				cover: track.cover || undefined,
				duration: track.duration ?? undefined,
				albumId: track.albumId ?? undefined,
				albumTitle: track.album ?? undefined,
				artistId: track.artistId ?? undefined,
				previewUrl: track.previewUrl ?? undefined,
			},
			callbacks
		);
	});

	const bitrate = track.bitrateLabel ?? "—";
	const isFlac = bitrate === "FLAC";
	const showBitrateCell = showBitrate && !!track.bitrateLabel;

	const hasNum = typeof trackNumber === "number";
	const cover = showCover || !hasNum;
	const gridClass = GRID[`${+hasNum}${+cover}${+showBitrateCell}${+showDuration}`];

	const handleHoverWarm = () => {
		if (isPlayerLoaded) return;
		// Hover signals strong intent — full audio buffer prefetch (~30s).
		warmTrack(track.trackId, { audio: "full" });
	};

	// Sliding-window prefetch: when this row scrolls into view, kick off a
	// light "head" prefetch (~3s of audio + server cache warm). warmTrack
	// budgets these per page (PREFETCH_LIMIT), so only the first rows fetch.
	const rowRef = useRef<HTMLDivElement>(null);
	useEffect(() => {
		if (isPlayerLoaded) return;
		const el = rowRef.current;
		if (!el || typeof IntersectionObserver === "undefined") return;
		const observer = new IntersectionObserver(
			(entries) => {
				for (const entry of entries) {
					if (entry.isIntersecting) {
						warmTrack(track.trackId, { audio: "head" });
						observer.disconnect();
						break;
					}
				}
			},
			{ rootMargin: "200px" }
		);
		observer.observe(el);
		return () => observer.disconnect();
	}, [track.trackId, isPlayerLoaded]);

	const activeRow = isActive || isPaused;

	return (
		<div
			{...longPress}
			ref={rowRef}
			onMouseEnter={handleHoverWarm}
			onFocus={handleHoverWarm}
			className={`group relative grid ${gridClass} items-center gap-3 overflow-hidden rounded-lg px-2 py-1.5 transition-colors duration-300 select-none ${
				activeRow ? "bg-accent" : "hover:bg-accent/60"
			}`}
		>
			{hasNum && !cover && (
				<button
					type="button"
					onClick={handlePlay}
					aria-label={isPlayerActive ? `Pause ${track.title}` : `Play ${track.title}`}
					className="flex h-10 items-center justify-end rounded-md tabular-nums focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
				>
					{activeRow ? (
						<PlaybackIndicator paused={isPaused} className="text-highlight" />
					) : (
						<>
							<span className="text-sm text-muted-foreground group-hover:hidden">{trackNumber}</span>
							<PlayPauseIcon playing={false} className="hidden size-4 text-foreground group-hover:block" />
						</>
					)}
				</button>
			)}
			{hasNum && cover && (
				<span className="flex items-center justify-end text-right tabular-nums">
					{activeRow ? (
						<PlaybackIndicator paused={isPaused} className="text-highlight" />
					) : (
						<span className="text-sm text-muted-foreground">{trackNumber}</span>
					)}
				</span>
			)}
			{cover && (
				<button
					type="button"
					onClick={handlePlay}
					aria-label={isPlayerActive ? `Pause ${track.title}` : `Play ${track.title}`}
					className="relative m-0 size-12 shrink-0 cursor-pointer appearance-none overflow-hidden rounded-lg border-0 bg-transparent p-0 shadow-[0_2px_6px_-2px_rgb(0_0_0/0.3)] transition-transform active:scale-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
				>
					<CoverImage
						src={track.cover || ""}
						className={`size-12 rounded-lg transition-transform duration-300 ${activeRow ? "" : "group-hover:scale-105"}`}
					/>
					{activeRow ? (
						<span className="absolute inset-0 flex items-center justify-center bg-black/55">
							<PlaybackIndicator paused={isPaused} className="text-white" />
						</span>
					) : (
						<span className="absolute inset-0 flex items-center justify-center bg-black/40 text-white opacity-0 transition-opacity duration-200 group-hover:opacity-100">
							<PlayPauseIcon playing={false} className="size-4" />
						</span>
					)}
				</button>
				)}
			<div className="min-w-0">
				<p className={`truncate text-sm font-medium leading-tight transition-colors duration-300 ${activeRow ? "text-highlight" : "text-foreground"}`}>
					{track.title}
				</p>
				<p className="mt-0.5 truncate text-xs leading-tight text-muted-foreground">
					{subtitle ?? (
						<>
							<ArtistLink id={track.artistId} name={track.artist} className="transition-colors hover:text-foreground" />
							{track.album && (
								<>
									{" · "}
									<AlbumLink id={track.albumId} title={track.album} artist={track.artist} className="transition-colors hover:text-foreground" />
								</>
							)}
						</>
					)}
				</p>
			</div>
			{showBitrateCell && (
				<span
					className={`rounded border border-border px-1.5 py-0.5 font-mono text-[10px] ${
						isFlac ? "text-foreground" : "text-muted-foreground"
					}`}
				>
					{bitrate}
				</span>
			)}
			{showDuration && (
				<span className="hidden text-right font-mono text-xs tabular-nums text-muted-foreground sm:inline">
					{track.duration ? convertDuration(track.duration) : ""}
				</span>
			)}
			<div className="flex items-center justify-end gap-0.5">
				<button
					type="button"
					aria-label={`Download ${track.title}`}
					title="Download"
					onClick={handleDownload}
					className="hidden size-9 items-center justify-center rounded-full text-muted-foreground opacity-0 transition-opacity hover:bg-background hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100 sm:inline-flex"
				>
					<DownloadGlyph />
				</button>
				{showSave && (
					<SaveButton
						track={{
							trackId: track.trackId,
							title: track.title,
							artist: track.artist,
							album: track.album ?? null,
							albumId: track.albumId ?? null,
							coverUrl: track.cover,
							duration: track.duration ?? null,
						}}
					/>
				)}
				<button
					type="button"
					aria-label={`More options for ${track.title}`}
					onClick={(e) => {
						e.stopPropagation();
						openSheet(
							{
								id: track.trackId,
								title: track.title,
								artist: track.artist,
								cover: track.cover || undefined,
								duration: track.duration ?? undefined,
								albumId: track.albumId ?? undefined,
								albumTitle: track.album ?? undefined,
								artistId: track.artistId ?? undefined,
								previewUrl: track.previewUrl ?? undefined,
							},
							callbacks
						);
					}}
					className="inline-flex size-9 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-surface-highest hover:text-foreground active:scale-90 md:hidden"
				>
					<MoreVertical className="size-5" />
				</button>
				<div className="hidden md:block">
					<TrackActionMenu
						track={{
							id: track.trackId,
							title: track.title,
							artist: track.artist,
							cover: track.cover || undefined,
							duration: track.duration ?? undefined,
							albumId: track.albumId ?? undefined,
							albumTitle: track.album ?? undefined,
							artistId: track.artistId ?? undefined,
							previewUrl: track.previewUrl ?? undefined,
						}}
						callbacks={callbacks}
					/>
				</div>
			</div>
		</div>
	);
}
