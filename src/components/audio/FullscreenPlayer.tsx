"use client";

import { memo, useEffect, useRef, useMemo, useCallback, useState } from "react";
import { usePlayerStore } from "@/stores/usePlayerStore";
import { useLyricsStore } from "@/stores/useLyricsStore";
import { useTrackActionStore } from "@/stores/useTrackActionStore";
import { useAuthStore } from "@/stores/useAuthStore";
import { useShareStore } from "@/stores/useShareStore";
import { CoverImage } from "@/components/ui/cover-image";
import {
	Carousel,
	CarouselContent,
	CarouselItem,
	type CarouselApi,
} from "@/components/ui/carousel";
import {
	DropdownMenu,
	DropdownMenuTrigger,
	DropdownMenuContent,
	DropdownMenuLabel,
	DropdownMenuGroup,
	DropdownMenuSeparator,
	DropdownMenuCheckboxItem,
} from "@/components/ui/dropdown-menu";
import { AudioVisualizer } from "./AudioVisualizer";
import { LyricsDisplay } from "./LyricsDisplay";
import { WaveSeek } from "./WaveSeek";
import { ImmersiveBackdrop } from "./ImmersiveBackdrop";
import { GaplessMenuItem } from "./GaplessMenuItem";
import { SaveButton } from "@/components/tracks/SaveButton";
import { ShareDialog } from "@/components/tracks/ShareDialog";
import { AddToPlaylist } from "@/components/playlists/AddToPlaylist";
import { coverThemeStyle, useCoverSeed, EASE, SPRING as KIT_SPRING } from "@/components/expressive";
import { motion, AnimatePresence, useDragControls, useTransform, type MotionValue } from "motion/react";
import {
	PlayPauseIcon,
	ShuffleGlyph,
	RepeatGlyph,
	SkipGlyph,
	VolumeGlyph,
	SlideSwap,
} from "@/components/motion/icons";
import Link from "next/link";
import { ChevronDown, Link as LinkIcon, ListMusic, MicVocal, MoreHorizontal, Radio, Share, SlidersHorizontal } from "lucide-react";
import { useAudioLevel } from "@/hooks/useAudioLevel";
import { cn } from "@/lib/utils";
import { ArtistLink, useOverlayLink } from "@/components/links/EntityLink";
import { trackRadioHref } from "@/lib/entity-links";
import { leavePlayer } from "./leave-player";
import { DevicePicker, PlayingOn } from "./DevicePicker";
import { useShownVolume } from "@/lib/playback-sync/useSyncStore";
import type { PlayerTrack } from "@/stores/usePlayerStore";

function seek(time: number) {
	usePlayerStore.getState().seek(time);
}

const SPRING = { type: "spring", stiffness: 380, damping: 30 } as const;

/** Translucent round button for the glassy top bar. */
const glassBtn =
	"inline-flex size-11 shrink-0 items-center justify-center rounded-full bg-surface-highest/45 text-foreground backdrop-blur-md transition-[background-color,scale] duration-200 hover:bg-surface-highest/70 active:scale-[0.88] outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40 data-popup-open:bg-surface-highest/80";

/* ─── Cover Carousel ─── */
/* Only re-renders when queue changes — immune to currentTime updates */
const CoverCarousel = memo(function CoverCarousel({
	queue,
}: {
	queue: PlayerTrack[];
}) {
	const carouselApiRef = useRef<CarouselApi>(undefined);
	const cleanupRef = useRef<(() => void) | undefined>(undefined);
	const carouselOpts = useMemo(() => ({ watchDrag: true }), []);

	const onCarouselApi = (api: CarouselApi) => {
		cleanupRef.current?.();
		carouselApiRef.current = api;
		if (!api) return;

		api.scrollTo(usePlayerStore.getState().queueIndex, true);

		const onSelect = () => {
			const selected = api.selectedScrollSnap();
			const storeIdx = usePlayerStore.getState().queueIndex;
			if (selected === storeIdx) return;

			if (selected > storeIdx) {
				usePlayerStore.getState().next();
			} else {
				usePlayerStore.getState().prevTrack();
			}

			const newIdx = usePlayerStore.getState().queueIndex;
			if (selected !== newIdx) {
				api.scrollTo(newIdx);
			}
		};

		api.on("select", onSelect);
		cleanupRef.current = () => api.off("select", onSelect);
	};

	// Sync carousel when queueIndex changes externally (buttons, etc.)
	useEffect(() => {
		return usePlayerStore.subscribe((state, prev) => {
			if (state.queueIndex === prev.queueIndex) return;
			const api = carouselApiRef.current;
			if (!api) return;
			if (api.selectedScrollSnap() !== state.queueIndex) {
				api.scrollTo(state.queueIndex);
			}
		});
	}, []);

	// Jump to correct slide when fullscreen opens
	useEffect(() => {
		return usePlayerStore.subscribe((state, prev) => {
			if (state.fullscreenOpen && !prev.fullscreenOpen) {
				carouselApiRef.current?.scrollTo(state.queueIndex, true);
			}
		});
	}, []);

	useEffect(() => () => cleanupRef.current?.(), []);

	return (
		<Carousel opts={carouselOpts} setApi={onCarouselApi} className="w-full overflow-hidden rounded-[28px]">
			<CarouselContent className="-ml-0">
				{queue.map((track) => (
					<CarouselItem key={track.trackId} className="pl-0">
						<CoverImage src={track.cover} className="aspect-square w-full rounded-[28px]" />
					</CarouselItem>
				))}
			</CarouselContent>
		</Carousel>
	);
});

/* ─── Cover Stage ─── */
/* The artwork settles back when paused, breathes gently with the bass while
   playing, and blooms a primary-coloured glow underneath (the Flutter `_CoverGlow`). */
function CoverStage({ queue, level }: { queue: PlayerTrack[]; level: MotionValue<number> }) {
	const isPlaying = usePlayerStore((s) => s.isPlaying);
	const pulse = useTransform(level, [0, 1], [1, 1.025]);

	return (
		<div className="flex min-h-0 flex-1 items-center justify-center px-6 py-3 min-[840px]:px-0">
			<motion.div
				data-testid="cover-stage"
				data-playing={isPlaying || undefined}
				className="relative aspect-square w-full max-w-[min(440px,100%,40vh)] min-[840px]:max-w-[min(540px,100%,64vh)]"
				initial={false}
				animate={{ scale: isPlaying ? 1 : 0.88 }}
				transition={{ type: "spring", stiffness: 260, damping: 18 }}
			>
				<div
					aria-hidden
					className={cn(
						"absolute inset-0 rounded-[28px] transition-[box-shadow] duration-700 ease-[cubic-bezier(0.2,0,0,1)]",
						isPlaying
							? "shadow-[0_18px_56px_2px_color-mix(in_oklch,var(--primary)_45%,transparent)]"
							: "shadow-[0_12px_20px_0_color-mix(in_oklch,var(--primary)_20%,transparent)]"
					)}
				/>
				<motion.div style={{ scale: pulse }} className="relative rounded-[28px] ring-1 ring-inset ring-foreground/5">
					<CoverCarousel queue={queue} />
				</motion.div>
			</motion.div>
		</div>
	);
}

/* ─── Track Info ─── */
function TrackInfo({ onActions }: { onActions: () => void }) {
	const currentTrack = usePlayerStore((s) => s.currentTrack);
	const isAuthenticated = useAuthStore((s) => s.isAuthenticated);

	const handleContextMenu = useCallback(
		(e: React.MouseEvent) => {
			e.preventDefault();
			onActions();
		},
		[onActions]
	);

	if (!currentTrack) return null;
	return (
		<div className="flex shrink-0 items-center gap-4 pb-4" onContextMenu={handleContextMenu}>
			<div className="relative min-w-0 flex-1">
				<AnimatePresence mode="popLayout" initial={false}>
					<motion.div
						key={currentTrack.trackId}
						initial={{ opacity: 0, x: 24 }}
						animate={{ opacity: 1, x: 0 }}
						exit={{ opacity: 0, x: -24 }}
						transition={{ duration: 0.35, ease: EASE.decelerate }}
					>
						<p className="line-clamp-2 text-[28px] font-semibold leading-[1.1] tracking-[-0.03em] text-foreground min-[840px]:text-[40px]">
							{currentTrack.title}
						</p>
						<p className="mt-1.5 truncate text-base font-semibold text-muted-foreground min-[840px]:text-lg">
							<ArtistLink id={currentTrack.artistId} name={currentTrack.artist} onClick={leavePlayer} className="rounded-md transition-colors hover:text-foreground" />
						</p>
					</motion.div>
				</AnimatePresence>
			</div>
			{isAuthenticated && (
				<SaveButton
					variant="tonal"
					track={{
						trackId: currentTrack.trackId,
						title: currentTrack.title,
						artist: currentTrack.artist,
						album: currentTrack.album ?? null,
						albumId: currentTrack.albumId ?? null,
						coverUrl: currentTrack.cover,
						duration: currentTrack.duration ?? null,
					}}
				/>
			)}
		</div>
	);
}

/* ─── Seek Section ─── */
function SeekSection() {
	const currentTime = usePlayerStore((s) => s.currentTime);
	const duration = usePlayerStore((s) => s.duration);
	const buffered = usePlayerStore((s) => s.buffered);
	const playing = usePlayerStore((s) => s.isPlaying && !s.isBuffering);
	return (
		<div className="shrink-0">
			<WaveSeek
				currentTime={currentTime}
				duration={duration}
				buffered={buffered}
				playing={playing}
				onSeek={seek}
				height={36}
				stroke={5}
				amplitude={4}
				wavelength={34}
				tone="primary"
				trackClassName="text-foreground/15"
			/>
		</div>
	);
}

/* ─── Controls ─── */

/** Round transport toggle that fills with a tonal container while on. */
function ToggleKey({
	label,
	on,
	disabled,
	onClick,
	children,
}: {
	label: string;
	on: boolean;
	disabled?: boolean;
	onClick: () => void;
	children: React.ReactNode;
}) {
	return (
		<motion.button
			type="button"
			aria-label={label}
			aria-pressed={on}
			disabled={disabled}
			whileTap={{ scale: 0.86 }}
			transition={KIT_SPRING.press}
			onClick={onClick}
			className={cn(
				"relative inline-flex size-12 items-center justify-center rounded-full outline-none transition-colors duration-300 focus-visible:ring-[3px] focus-visible:ring-ring/30 disabled:pointer-events-none disabled:opacity-30 [&_svg]:size-[22px]",
				on ? "bg-primary-container text-on-primary-container" : "text-muted-foreground hover:bg-foreground/8 hover:text-foreground"
			)}
		>
			{children}
		</motion.button>
	);
}

function Controls() {
	const isPlaying = usePlayerStore((s) => s.isPlaying);
	const isBuffering = usePlayerStore((s) => s.isBuffering);
	const shuffle = usePlayerStore((s) => s.shuffle);
	const repeat = usePlayerStore((s) => s.repeat);
	const hasQueue = usePlayerStore((s) => s.queue.length > 1);

	const toggle = usePlayerStore((s) => s.toggle);
	const next = usePlayerStore((s) => s.next);
	const prevTrack = usePlayerStore((s) => s.prevTrack);
	const toggleShuffle = usePlayerStore((s) => s.toggleShuffle);
	const toggleRepeat = usePlayerStore((s) => s.toggleRepeat);

	return (
		<div className="flex shrink-0 items-center justify-between pb-5 pt-3">
			<ToggleKey label="Shuffle" on={shuffle} disabled={!hasQueue} onClick={toggleShuffle}>
				<ShuffleGlyph active={shuffle} />
			</ToggleKey>

			<motion.button
				type="button"
				aria-label="Previous track"
				whileTap={{ scale: 0.84, x: -4 }}
				onClick={prevTrack}
				className="inline-flex size-14 items-center justify-center rounded-full text-foreground outline-none transition-colors hover:bg-foreground/8 focus-visible:ring-[3px] focus-visible:ring-ring/30"
			>
				<SkipGlyph dir="prev" className="size-8" />
			</motion.button>

			<span className="relative inline-flex size-[88px] shrink-0 items-center justify-center">
				<motion.button
					type="button"
					aria-label={isPlaying ? "Pause" : "Play"}
					initial={false}
					// Squircle when paused, circle when playing (M3 expressive).
					animate={{ borderRadius: isPlaying ? 40 : 26 }}
					whileHover={{ scale: 1.03 }}
					whileTap={{ scale: 0.88 }}
					transition={{ borderRadius: { duration: 0.3, ease: EASE.emphasized }, scale: SPRING }}
					onClick={toggle}
					className={cn(
						"relative inline-flex size-20 items-center justify-center text-primary-foreground outline-none transition-shadow duration-500 focus-visible:ring-[3px] focus-visible:ring-ring/40",
						"bg-[linear-gradient(135deg,var(--primary),color-mix(in_oklch,var(--primary)_45%,var(--m3-tertiary)))]",
						isPlaying
							? "shadow-[0_8px_26px_-2px_color-mix(in_oklch,var(--primary)_55%,transparent)]"
							: "shadow-[0_6px_12px_-2px_color-mix(in_oklch,var(--primary)_40%,transparent)]"
					)}
				>
					<PlayPauseIcon playing={isPlaying} className="size-10" />
				</motion.button>
				<AnimatePresence>
					{isPlaying && isBuffering && (
						<motion.svg
							aria-hidden
							data-testid="play-buffering"
							viewBox="0 0 88 88"
							className="pointer-events-none absolute inset-0 text-primary"
							initial={{ opacity: 0 }}
							animate={{ opacity: 1, rotate: 360 }}
							exit={{ opacity: 0 }}
							transition={{ opacity: { duration: 0.15 }, rotate: { repeat: Infinity, duration: 1, ease: "linear" } }}
						>
							<circle cx="44" cy="44" r="42.5" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeDasharray="70 200" />
						</motion.svg>
					)}
				</AnimatePresence>
			</span>

			<motion.button
				type="button"
				aria-label="Next track"
				whileTap={{ scale: 0.84, x: 4 }}
				onClick={next}
				className="inline-flex size-14 items-center justify-center rounded-full text-foreground outline-none transition-colors hover:bg-foreground/8 focus-visible:ring-[3px] focus-visible:ring-ring/30"
			>
				<SkipGlyph dir="next" className="size-8" />
			</motion.button>

			<ToggleKey label={`Repeat ${repeat}`} on={repeat !== "off"} disabled={!hasQueue} onClick={toggleRepeat}>
				<RepeatGlyph mode={repeat} />
			</ToggleKey>
		</div>
	);
}

/* ─── Volume (wide screens) ─── */
function VolumeSection() {
	const volume = useShownVolume();
	const setVolume = usePlayerStore((s) => s.setVolume);
	const toggleMute = usePlayerStore((s) => s.toggleMute);
	return (
		<div className="mb-4 hidden min-w-0 items-center gap-3 min-[840px]:flex">
			<button
				type="button"
				onClick={toggleMute}
				aria-label={volume === 0 ? "Unmute" : "Mute"}
				aria-pressed={volume === 0}
				className="inline-flex size-9 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-foreground/8 hover:text-foreground active:scale-90"
			>
				<VolumeGlyph volume={volume} />
			</button>
			<div className="group/vol relative flex h-6 flex-1 items-center">
				<div className="relative h-1.5 w-full overflow-hidden rounded-full bg-foreground/12 transition-[height] duration-150 group-hover/vol:h-2">
					<div className="absolute inset-y-0 left-0 rounded-full bg-primary" style={{ width: `${volume}%` }} />
				</div>
				<span
					aria-hidden
					className="pointer-events-none absolute size-4 -translate-x-1/2 scale-0 rounded-full bg-primary shadow-sm transition-transform duration-150 group-hover/vol:scale-100"
					style={{ left: `${volume}%` }}
				/>
				<input
					type="range"
					min={0}
					max={100}
					value={volume}
					aria-label="Volume"
					onChange={(e) => setVolume(parseInt(e.target.value))}
					className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
				/>
			</div>
			<span className="w-7 text-right text-xs font-semibold tabular-nums text-muted-foreground">{volume}</span>
		</div>
	);
}

function ExtraControls() {
	const crossfadeDuration = usePlayerStore((s) => s.crossfadeDuration);
	const setCrossfadeDuration = usePlayerStore((s) => s.setCrossfadeDuration);
	const normalizationEnabled = usePlayerStore((s) => s.normalizationEnabled);
	const toggleNormalization = usePlayerStore((s) => s.toggleNormalization);
	const gapless = usePlayerStore((s) => s.gapless);
	const toggleGapless = usePlayerStore((s) => s.toggleGapless);
	const autoplay = usePlayerStore((s) => s.autoplay);
	const toggleAutoplay = usePlayerStore((s) => s.toggleAutoplay);

	return (
		<DropdownMenu>
			<DropdownMenuTrigger aria-label="Audio settings" title="Audio settings" className={glassBtn}>
				<SlidersHorizontal className="size-[18px]" />
			</DropdownMenuTrigger>
			<DropdownMenuContent side="bottom" align="end" sideOffset={8} className="w-64 rounded-2xl p-1.5">
				<DropdownMenuGroup>
					<DropdownMenuLabel className="px-2.5 text-[11px] font-semibold uppercase tracking-[0.12em] text-primary">Crossfade</DropdownMenuLabel>
					<div className="flex gap-1 px-1.5 pb-1.5">
						{([0, 1, 2, 3, 5, 8] as const).map((s) => (
							<button
								key={s}
								type="button"
								aria-pressed={crossfadeDuration === s}
								onClick={() => setCrossfadeDuration(s)}
								className={cn(
									"h-8 flex-1 rounded-full text-[11px] font-semibold tabular-nums transition-colors active:scale-95",
									crossfadeDuration === s ? "bg-primary text-primary-foreground" : "bg-surface-high text-muted-foreground hover:bg-surface-highest hover:text-foreground"
								)}
							>
								{s === 0 ? "Off" : `${s}s`}
							</button>
						))}
					</div>
				</DropdownMenuGroup>
				<DropdownMenuSeparator />
				<DropdownMenuCheckboxItem checked={normalizationEnabled} onClick={toggleNormalization} className="rounded-xl py-2">
					Loudness normalization
				</DropdownMenuCheckboxItem>
				<GaplessMenuItem on={gapless} crossfade={crossfadeDuration > 0} onToggle={toggleGapless} />
				<DropdownMenuCheckboxItem checked={autoplay} onClick={toggleAutoplay} className="rounded-xl py-2">
					Autoplay similar tracks
				</DropdownMenuCheckboxItem>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

/* ─── Action pill: lyrics · queue · share · add to playlist ─── */
function ActionPill({ lyrics, onToggleLyrics }: { lyrics: boolean; onToggleLyrics: () => void }) {
	const currentTrack = usePlayerStore((s) => s.currentTrack);
	const upNext = usePlayerStore((s) => (s.queueIndex >= 0 ? Math.max(0, s.queue.length - s.queueIndex - 1) : 0));
	const setQueuePanelOpen = usePlayerStore((s) => s.setQueuePanelOpen);
	const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
	const isShared = useShareStore((s) => (currentTrack ? s.shared.has(currentTrack.trackId) : false));
	const [shareOpen, setShareOpen] = useState(false);
	const radioLink = useOverlayLink(leavePlayer);

	if (!currentTrack) return null;
	const radioHref = isAuthenticated ? trackRadioHref(currentTrack.trackId) : null;
	const pillKey =
		"inline-flex size-11 shrink-0 items-center justify-center rounded-full text-foreground outline-none transition-[background-color,color,scale] duration-300 hover:bg-foreground/8 active:scale-[0.86] focus-visible:ring-[3px] focus-visible:ring-ring/30 [&_svg]:size-5";

	return (
		<div className="flex shrink-0 items-center gap-1 rounded-full bg-surface-highest/50 p-1 backdrop-blur-md">
			<button
				type="button"
				aria-label="Toggle lyrics"
				aria-pressed={lyrics}
				title={lyrics ? "Hide lyrics" : "Lyrics"}
				onClick={onToggleLyrics}
				className={cn(pillKey, lyrics && "bg-primary text-primary-foreground hover:bg-primary/90")}
			>
				<MicVocal />
			</button>
			<button
				type="button"
				onClick={() => setQueuePanelOpen(true)}
				className="inline-flex h-11 min-w-0 flex-1 items-center justify-center gap-2 rounded-full px-3 text-sm font-semibold text-primary outline-none transition-[background-color,scale] hover:bg-primary/10 active:scale-[0.96] focus-visible:ring-[3px] focus-visible:ring-ring/30"
			>
				<ListMusic className="size-5 shrink-0" />
				<SlideSwap id={upNext} className="truncate">
					{upNext === 0 ? "Queue" : `${upNext} up next`}
				</SlideSwap>
			</button>
			<DevicePicker className={cn(pillKey, "data-popup-open:bg-foreground/8")} />
			{radioHref && (
				<Link href={radioHref} replace={radioLink.replace} onClick={radioLink.onClick} aria-label="Song radio" title="Song radio" className={cn(pillKey, "no-underline")}>
					<Radio />
				</Link>
			)}
			{isAuthenticated && (
				<>
					<button
						type="button"
						aria-label={isShared ? "Manage share link" : "Share track"}
						title={isShared ? "Manage share link" : "Share"}
						onClick={() => setShareOpen(true)}
						className={cn(pillKey, isShared && "text-primary")}
					>
						{isShared ? <LinkIcon /> : <Share />}
					</button>
					<AddToPlaylist
						track={{
							trackId: currentTrack.trackId,
							title: currentTrack.title,
							artist: currentTrack.artist,
							album: currentTrack.album ?? null,
							albumId: currentTrack.albumId ?? null,
							coverUrl: currentTrack.cover,
							duration: currentTrack.duration,
						}}
						className={cn(pillKey, "h-11 w-11 hover:bg-foreground/8 [&_svg]:!size-5")}
					/>
					<ShareDialog
						open={shareOpen}
						onOpenChange={setShareOpen}
						trackId={currentTrack.trackId}
						duration={currentTrack.duration}
						title={currentTrack.title}
						artist={currentTrack.artist}
						album={currentTrack.album ?? null}
						cover={currentTrack.cover}
					/>
				</>
			)}
		</div>
	);
}

/* ─── Shell ─── */
/* Only subscribes to fullscreenOpen + currentTrack (for mount/unmount) */
export function FullscreenPlayer() {
	const fullscreenOpen = usePlayerStore((s) => s.fullscreenOpen);
	const setFullscreenOpen = usePlayerStore((s) => s.setFullscreenOpen);
	const setQueuePanelOpen = usePlayerStore((s) => s.setQueuePanelOpen);
	const currentTrack = usePlayerStore((s) => s.currentTrack);
	const queue = usePlayerStore((s) => s.queue);
	const queueIndex = usePlayerStore((s) => s.queueIndex);
	const audible = usePlayerStore((s) => s.isPlaying && !s.isBuffering);
	const openSheet = useTrackActionStore((s) => s.openSheet);
	const dragControls = useDragControls();
	const lyricsVisible = useLyricsStore((s) => s.visible);
	const toggleLyrics = useLyricsStore((s) => s.toggleVisible);
	const fetchLyrics = useLyricsStore((s) => s.fetchLyrics);
	const level = useAudioLevel(fullscreenOpen && audible);
	const seed = useCoverSeed(currentTrack?.cover);

	const hasQueue = queue.length > 1;

	// Modal focus: land on Close when it opens, hand the focus back to the opener when it closes
	// (the page behind is made inert by the main layout; Escape is handled by useKeyboardShortcuts).
	const closeRef = useRef<HTMLButtonElement>(null);
	const opener = useRef<HTMLElement | null>(null);
	const open = fullscreenOpen && !!currentTrack;
	useEffect(() => {
		if (!open) return;
		const active = document.activeElement;
		opener.current = active instanceof HTMLElement && active !== document.body ? active : null;
		closeRef.current?.focus({ preventScroll: true });
		return () => {
			const el = opener.current;
			opener.current = null;
			if (el?.isConnected) el.focus({ preventScroll: true });
		};
	}, [open]);

	useEffect(() => {
		if (fullscreenOpen) {
			document.body.style.overflow = "hidden";
			return () => {
				document.body.style.overflow = "";
			};
		}
	}, [fullscreenOpen]);

	useEffect(() => {
		if (!currentTrack && fullscreenOpen) {
			setFullscreenOpen(false);
		}
	}, [currentTrack, fullscreenOpen, setFullscreenOpen]);

	// Auto-fetch lyrics when visible and track changes
	useEffect(() => {
		if (lyricsVisible && currentTrack) {
			fetchLyrics(currentTrack.trackId, currentTrack.duration);
		}
	}, [lyricsVisible, currentTrack, fetchLyrics]);

	const openActions = useCallback(() => {
		if (!currentTrack) return;
		openSheet({
			id: currentTrack.trackId,
			title: currentTrack.title,
			artist: currentTrack.artist,
			artistId: currentTrack.artistId ?? null,
			albumId: currentTrack.albumId ?? null,
			albumTitle: currentTrack.album ?? null,
			cover: currentTrack.cover,
			duration: currentTrack.duration,
		});
	}, [currentTrack, openSheet]);

	const handleToggleLyrics = () => {
		// Lyrics take over the stage here, so the floating queue makes room.
		if (!lyricsVisible) setQueuePanelOpen(false);
		toggleLyrics();
	};

	const handleDragEnd = (
		_: unknown,
		info: { offset: { y: number }; velocity: { y: number } }
	) => {
		if (info.offset.y > 100 || info.velocity.y > 500) {
			setFullscreenOpen(false);
		}
	};

	return (
		<AnimatePresence>
			{fullscreenOpen && currentTrack && (
				<motion.div
					key="fullscreen-player"
					initial={{ y: "100%" }}
					animate={{ y: 0 }}
					exit={{ y: "100%" }}
					transition={{ type: "spring", damping: 30, stiffness: 300 }}
					drag="y"
					dragControls={dragControls}
					dragListener={false}
					dragConstraints={{ top: 0, bottom: 0 }}
					dragElastic={{ top: 0, bottom: 0.4 }}
					onDragEnd={handleDragEnd}
					role="dialog"
					aria-modal="true"
					aria-label="Now playing"
					data-hotkeys="player"
					// z-58: above the app chrome (nav 40, player 45), below sheets, menus,
					// dialogs and the queue (60) so they can open on top of Now Playing.
					className="cover-theme fixed inset-0 z-[58] isolate flex flex-col overflow-hidden text-foreground"
					style={coverThemeStyle(seed)}
				>
					<ImmersiveBackdrop cover={currentTrack.cover} level={level} />

					{/* Drag handle */}
					<div
						className="flex shrink-0 cursor-grab touch-none items-center justify-center pb-1 pt-[max(0.625rem,env(safe-area-inset-top))] active:cursor-grabbing"
						onPointerDown={(e) => dragControls.start(e)}
						role="button"
						aria-label="Drag down to close"
					>
						<div className="h-1 w-9 rounded-full bg-foreground/25" />
					</div>

					{/* Top bar — glass round buttons around the "playing from" eyebrow. Equal 1fr side slots keep the
					    eyebrow centred even though the right side holds two buttons and the left only one. */}
					<div data-testid="np-topbar" className="mx-auto grid w-full max-w-6xl shrink-0 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2 px-3 py-1 min-[840px]:px-8">
						<div className="flex justify-start">
							<button
								ref={closeRef}
								type="button"
								aria-label="Close fullscreen player"
								title="Close"
								onClick={() => setFullscreenOpen(false)}
								className={glassBtn}
							>
								<ChevronDown className="size-6" />
							</button>
						</div>
						<div className="flex min-w-0 flex-col items-center text-center">
							<span className="type-eyebrow tracking-[0.18em] text-primary">
								<SlideSwap id={lyricsVisible ? "lyrics" : "playing"}>{lyricsVisible ? "Lyrics" : "Now playing"}</SlideSwap>
							</span>
							{hasQueue && queueIndex >= 0 && (
								<span className="mt-0.5 truncate text-sm font-semibold tabular-nums text-foreground/90">
									{queueIndex + 1} of {queue.length} in queue
								</span>
							)}
						</div>
						<div className="flex items-center justify-end gap-2">
							<ExtraControls />
							<button type="button" aria-label="Track actions" title="More" onClick={openActions} className={glassBtn}>
								<MoreHorizontal className="size-5" />
							</button>
						</div>
					</div>

					{/* Body — stacked on phones, artwork | controls side by side from 840px */}
					<div className="mx-auto flex min-h-0 w-full max-w-6xl flex-1 flex-col min-[840px]:grid min-[840px]:grid-cols-2 min-[840px]:gap-14 min-[840px]:px-12 min-[840px]:pb-10 xl:gap-20">
						<div className="flex min-h-0 flex-1 flex-col min-[840px]:h-full">
							<AnimatePresence mode="wait" initial={false}>
								<motion.div
									key={lyricsVisible ? "lyrics" : "cover"}
									initial={{ opacity: 0, scale: 0.94 }}
									animate={{ opacity: 1, scale: 1 }}
									exit={{ opacity: 0, scale: 0.94 }}
									transition={{ duration: 0.3, ease: EASE.emphasized }}
									className="flex min-h-0 flex-1 flex-col"
								>
									{lyricsVisible ? <LyricsDisplay /> : <CoverStage queue={queue} level={level} />}
								</motion.div>
							</AnimatePresence>
						</div>

						<div className="mx-auto flex w-full max-w-[520px] shrink-0 flex-col px-6 pb-[max(1.25rem,env(safe-area-inset-bottom))] min-[840px]:self-center min-[840px]:px-0 min-[840px]:pb-0">
							<TrackInfo onActions={openActions} />
							<div className="mb-2 hidden h-8 shrink-0 min-[840px]:block">
								<AudioVisualizer barCount={48} className="h-full text-primary/60" />
							</div>
							<SeekSection />
							<Controls />
							<VolumeSection />
							<PlayingOn className="mb-2 justify-center self-center text-xs font-semibold" />
							<ActionPill lyrics={lyricsVisible} onToggleLyrics={handleToggleLyrics} />
						</div>
					</div>
				</motion.div>
			)}
		</AnimatePresence>
	);
}
