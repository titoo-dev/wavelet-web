"use client";

import { useEffect, useRef, type ReactElement } from "react";
import { motion, AnimatePresence } from "motion/react";
import { Maximize2, MoreHorizontal, SlidersHorizontal, X } from "lucide-react";
import { usePlayerStore } from "@/stores/usePlayerStore";
import { useLyricsStore } from "@/stores/useLyricsStore";
import { useTrackActionStore } from "@/stores/useTrackActionStore";
import { useDownloadStore } from "@/stores/useDownloadStore";
import { useAuthStore } from "@/stores/useAuthStore";
import { CoverImage } from "@/components/ui/cover-image";
import {
	DropdownMenu,
	DropdownMenuTrigger,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuGroup,
	DropdownMenuSeparator,
	DropdownMenuCheckboxItem,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { DownloadGlyph, Equalizer, PlayPauseIcon } from "@/components/motion/icons";
import { CoverTheme, EASE, SPRING } from "@/components/expressive";
import { SaveButton } from "@/components/tracks/SaveButton";
import { SeekBar } from "./SeekBar";
import { WaveSeek } from "./WaveSeek";
import { GaplessMenuItem } from "./GaplessMenuItem";
import { cn } from "@/lib/utils";
import { ArtistLink } from "@/components/links/EntityLink";
import { leavePlayer } from "./leave-player";
import { DevicePicker, PlayingOn } from "./DevicePicker";
import { shownVolume, useShownVolume } from "@/lib/playback-sync/useSyncStore";
import { toast } from "sonner";

function Tip({ label, trigger, children }: { label: string; trigger: ReactElement; children: React.ReactNode }) {
	return (
		<Tooltip>
			<TooltipTrigger render={trigger}>{children}</TooltipTrigger>
			<TooltipContent>{label}</TooltipContent>
		</Tooltip>
	);
}

/** Round icon key on the glass card: muted ink, soft hover wash. */
const ctl =
	"inline-flex items-center justify-center rounded-full text-muted-foreground transition-[color,background-color,scale] duration-200 hover:bg-foreground/[0.06] hover:text-foreground active:scale-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40";
/** Toggle keys (shuffle, repeat, queue, lyrics) take a soft wash of the cover accent while on. */
const ctlOn = "bg-primary/12 text-primary hover:bg-primary/18 hover:text-primary";

function PrevGlyph() {
	return (
		<svg viewBox="0 0 24 24" fill="currentColor" className="size-[18px]" aria-hidden>
			<rect x="4" y="5" width="2.2" height="14" rx="1.1" />
			<path d="M19 5.8v12.4a1 1 0 0 1-1.52.85L8.5 13.2a1.4 1.4 0 0 1 0-2.4l8.98-5.85A1 1 0 0 1 19 5.8z" />
		</svg>
	);
}

function NextGlyph({ className = "size-[18px]" }: { className?: string }) {
	return (
		<svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden>
			<rect x="17.8" y="5" width="2.2" height="14" rx="1.1" />
			<path d="M5 5.8v12.4a1 1 0 0 0 1.52.85l8.98-5.85a1.4 1.4 0 0 0 0-2.4L6.52 4.95A1 1 0 0 0 5 5.8z" />
		</svg>
	);
}

/** Indeterminate ring around the play key while the stream buffers. */
function BufferRing({ show, className }: { show: boolean; className?: string }) {
	return (
		<AnimatePresence>
			{show && (
				<motion.svg
					aria-hidden
					data-testid="player-buffering"
					viewBox="0 0 40 40"
					className={cn("pointer-events-none absolute text-primary", className)}
					initial={{ opacity: 0 }}
					animate={{ opacity: 1, rotate: 360 }}
					exit={{ opacity: 0 }}
					transition={{ opacity: { duration: 0.15 }, rotate: { repeat: Infinity, duration: 1, ease: "linear" } }}
				>
					<circle cx="20" cy="20" r="18.5" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeDasharray="34 82" />
				</motion.svg>
			)}
		</AnimatePresence>
	);
}

/** Volume points per wheel notch. */
const VOLUME_STEP = 5;

/** Volume key with its slider popping above the card (a clear gap off the top edge) instead of widening the pill.
 *  No tooltip on the key: it would open right over the slider. The wheel nudges the volume while hovering. */
function VolumeControl() {
	const volume = useShownVolume();
	const setVolume = usePlayerStore((s) => s.setVolume);
	const toggleMute = usePlayerStore((s) => s.toggleMute);
	const ref = useRef<HTMLDivElement>(null);

	// Native, non-passive listener: React's wheel handler is passive, so it couldn't stop the page scrolling.
	useEffect(() => {
		const el = ref.current;
		if (!el) return;
		const onWheel = (e: WheelEvent) => {
			if (e.deltaY === 0) return;
			e.preventDefault();
			// From the shown volume: the Active Device's while this tab is a Remote (was: this tab's own, a jump).
			const step = e.deltaY < 0 ? VOLUME_STEP : -VOLUME_STEP;
			usePlayerStore.getState().setVolume(Math.min(100, Math.max(0, shownVolume() + step)));
		};
		el.addEventListener("wheel", onWheel, { passive: false });
		return () => el.removeEventListener("wheel", onWheel);
	}, []);

	const show =
		"group-hover/vol:visible group-hover/vol:translate-y-0 group-hover/vol:scale-100 group-hover/vol:opacity-100 group-hover/vol:delay-0 " +
		"group-has-[:active]/vol:visible group-has-[:active]/vol:translate-y-0 group-has-[:active]/vol:scale-100 group-has-[:active]/vol:opacity-100 " +
		"group-has-[:focus-visible]/vol:visible group-has-[:focus-visible]/vol:translate-y-0 group-has-[:focus-visible]/vol:scale-100 group-has-[:focus-visible]/vol:opacity-100";

	return (
		<div ref={ref} data-testid="volume-control" className="group/vol relative">
			<button
				type="button"
				onClick={toggleMute}
				aria-label={volume === 0 ? "Unmute" : "Mute"}
				aria-pressed={volume === 0}
				className={cn(ctl, "size-9", volume === 0 && ctlOn)}
			>
				<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="size-[18px]">
					<path d="M11 5 6 9H2v6h4l5 4V5z" />
					<motion.path d="M15.5 8.5a5 5 0 0 1 0 7" initial={false} animate={{ pathLength: volume > 0 ? 1 : 0, opacity: volume > 0 ? 1 : 0 }} />
					<motion.path d="M19 5a10 10 0 0 1 0 14" initial={false} animate={{ pathLength: volume > 50 ? 1 : 0, opacity: volume > 50 ? 1 : 0 }} />
					<motion.path d="m17 9 6 6M23 9l-6 6" initial={false} animate={{ pathLength: volume === 0 ? 1 : 0, opacity: volume === 0 ? 1 : 0 }} />
				</svg>
			</button>
			{/* The padding is a hover bridge from the key up past the card's top edge, plus a 12px gap; `invisible`
			    (not pointer-events) hides it, so the 200ms close delay doubles as a grace period for the pointer. */}
			<div
				className={cn(
					"invisible absolute bottom-full left-1/2 origin-bottom -translate-x-1/2 translate-y-1.5 scale-95 pb-[calc((var(--player-h)-2.25rem)/2+12px)] opacity-0 transition-[opacity,visibility,translate,scale] delay-200 duration-200 ease-[cubic-bezier(0.2,0,0,1)]",
					show
				)}
			>
				<div className="glass flex items-center gap-3 rounded-full py-2.5 pl-4 pr-3.5 text-foreground shadow-popover">
					<div className="group/slider relative h-1.5 w-32 rounded-full bg-primary/15">
						<div className="absolute inset-y-0 left-0 rounded-full bg-primary" style={{ width: `${volume}%` }} />
						<span
							aria-hidden
							className="absolute top-1/2 size-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary shadow transition-[scale] duration-150 group-hover/slider:scale-115 group-has-[:active]/slider:scale-125"
							style={{ left: `${volume}%` }}
						/>
						<input
							type="range"
							min={0}
							max={100}
							value={volume}
							aria-label="Volume"
							onChange={(e) => setVolume(parseInt(e.target.value))}
							className="absolute -inset-y-3 inset-x-0 h-7 w-full cursor-pointer opacity-0"
						/>
					</div>
					<span className="w-7 text-right text-xs font-semibold tabular-nums text-muted-foreground">{volume}</span>
				</div>
			</div>
		</div>
	);
}

export function Player() {
	const currentTrack = usePlayerStore((s) => s.currentTrack);
	const isPlaying = usePlayerStore((s) => s.isPlaying);
	const isBuffering = usePlayerStore((s) => s.isBuffering);
	const currentTime = usePlayerStore((s) => s.currentTime);
	const duration = usePlayerStore((s) => s.duration);
	const buffered = usePlayerStore((s) => s.buffered);
	const shuffle = usePlayerStore((s) => s.shuffle);
	const repeat = usePlayerStore((s) => s.repeat);
	const queue = usePlayerStore((s) => s.queue);

	const toggle = usePlayerStore((s) => s.toggle);
	const stop = usePlayerStore((s) => s.stop);
	const next = usePlayerStore((s) => s.next);
	const prev = usePlayerStore((s) => s.prev);
	const toggleShuffle = usePlayerStore((s) => s.toggleShuffle);
	const toggleRepeat = usePlayerStore((s) => s.toggleRepeat);
	const crossfadeDuration = usePlayerStore((s) => s.crossfadeDuration);
	const setCrossfadeDuration = usePlayerStore((s) => s.setCrossfadeDuration);
	const normalizationEnabled = usePlayerStore((s) => s.normalizationEnabled);
	const toggleNormalization = usePlayerStore((s) => s.toggleNormalization);
	const gapless = usePlayerStore((s) => s.gapless);
	const toggleGapless = usePlayerStore((s) => s.toggleGapless);
	const setFullscreenOpen = usePlayerStore((s) => s.setFullscreenOpen);
	const queuePanelOpen = usePlayerStore((s) => s.queuePanelOpen);
	const setQueuePanelOpen = usePlayerStore((s) => s.setQueuePanelOpen);
	const openSheet = useTrackActionStore((s) => s.openSheet);
	const enqueueDownload = useDownloadStore((s) => s.enqueue);
	const isAuthenticated = useAuthStore((s) => s.isAuthenticated);

	const lyricsVisible = useLyricsStore((s) => s.visible);
	const toggleLyrics = useLyricsStore((s) => s.toggleVisible);
	const setLyricsVisible = useLyricsStore((s) => s.setVisible);

	const hasQueue = queue.length > 1;
	const audible = isPlaying && !isBuffering;

	// Queue and lyrics share the same floating slot on the right.
	const handleToggleQueue = () => {
		const nextOpen = !queuePanelOpen;
		setQueuePanelOpen(nextOpen);
		if (nextOpen && lyricsVisible) setLyricsVisible(false);
	};
	const handleToggleLyrics = () => {
		if (!lyricsVisible && queuePanelOpen) setQueuePanelOpen(false);
		toggleLyrics();
	};

	const handleContextMenu = (e: React.MouseEvent) => {
		e.preventDefault();
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
	};

	const handleDownload = () => {
		if (!currentTrack) return;
		if (!isAuthenticated) {
			toast("Sign in to download");
			return;
		}
		const n = enqueueDownload([
			{
				trackId: currentTrack.trackId,
				title: currentTrack.title,
				artist: currentTrack.artist,
				cover: currentTrack.cover,
				duration: currentTrack.duration,
			},
		]);
		toast(n ? `Downloading “${currentTrack.title}”` : "Already downloading");
	};

	const seek = usePlayerStore((s) => s.seek);

	return (
		<AnimatePresence>
			{currentTrack && (
				<motion.div
					key="player"
					role="region"
					aria-label="Player controls"
					initial={{ y: 120, opacity: 0, scale: 0.96 }}
					animate={{ y: 0, opacity: 1, scale: 1 }}
					exit={{ y: 120, opacity: 0, scale: 0.96 }}
					transition={{ type: "spring", damping: 30, stiffness: 320 }}
					className="fixed bottom-[var(--player-offset)] left-[var(--rail-w)] right-0 z-[45] mx-auto w-[min(920px,calc(100%-var(--rail-w)-24px))]"
				>
					<CoverTheme src={currentTrack.cover}>
						{/* Geist glass card (the header's surface). The artwork only tints a wash behind the cover and the
						    glow underneath, which blooms while playing. Equal side columns keep the transport centred. */}
						<div
							data-playing={audible || undefined}
							className={cn(
								"glass relative isolate flex h-[var(--player-h)] items-center gap-1 rounded-[22px] pb-2.5 pl-1.5 pr-1 text-foreground transition-shadow duration-500 ease-[cubic-bezier(0.2,0,0,1)] sm:gap-2 md:grid md:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] md:gap-4 md:pb-0 md:pl-2.5 md:pr-3",
								"ring-1 ring-inset ring-border dark:ring-white/10",
								audible
									? "shadow-[0_18px_40px_-14px_color-mix(in_oklch,var(--m3-primary)_55%,transparent),0_2px_6px_-2px_rgb(0_0_0/0.08)]"
									: "shadow-[0_12px_32px_-14px_rgb(0_0_0/0.28),0_2px_6px_-2px_rgb(0_0_0/0.08)]"
							)}
						>
							{/* Cover wash: its own clipped layer so the volume popover can still overflow the card. */}
							<div aria-hidden className="pointer-events-none absolute inset-0 -z-10 overflow-hidden rounded-[inherit]">
								<div className="absolute inset-0 bg-[radial-gradient(70%_180%_at_0%_50%,color-mix(in_oklch,var(--m3-primary-container)_90%,transparent),transparent_70%)] dark:opacity-70" />
							</div>
							{/* Track */}
							<div className="flex min-w-0 flex-1 items-center gap-2.5 sm:gap-3" onContextMenu={handleContextMenu}>
								<motion.button
									type="button"
									aria-label="Open fullscreen player"
									onClick={() => setFullscreenOpen(true)}
									initial={false}
									animate={{ scale: isPlaying ? 1 : 0.9 }}
									whileTap={{ scale: 0.85 }}
									transition={{ type: "spring", stiffness: 400, damping: 17 }}
									className="group/cover relative size-11 shrink-0 overflow-hidden rounded-[12px] shadow-[0_6px_16px_-6px_rgb(0_0_0/0.45)] outline-none focus-visible:ring-2 focus-visible:ring-ring/50 md:size-12"
								>
									<AnimatePresence mode="popLayout" initial={false}>
										<motion.div
											key={currentTrack.trackId}
											initial={{ opacity: 0, scale: 0.8, rotate: -6 }}
											animate={{ opacity: 1, scale: 1, rotate: 0 }}
											exit={{ opacity: 0, scale: 0.8, rotate: 6 }}
											transition={{ type: "spring", stiffness: 380, damping: 28 }}
											className="absolute inset-0"
										>
											<CoverImage src={currentTrack.cover} className="size-full rounded-[12px]" />
										</motion.div>
									</AnimatePresence>
									<span className="absolute inset-0 hidden items-center justify-center bg-black/40 text-white opacity-0 transition-opacity group-hover/cover:opacity-100 md:flex">
										<Maximize2 className="size-4" />
									</span>
								</motion.button>
								{/* Tapping the text opens Now Playing too (the Flutter mini player is one big tap target). */}
								<div className="min-w-0 flex-1 cursor-pointer md:flex-initial" onClick={() => setFullscreenOpen(true)}>
									<AnimatePresence mode="popLayout" initial={false}>
										<motion.div
											key={currentTrack.trackId}
											initial={{ opacity: 0, y: 8 }}
											animate={{ opacity: 1, y: 0 }}
											exit={{ opacity: 0, y: -6 }}
											transition={{ duration: 0.3, ease: EASE.decelerate }}
											className="min-w-0"
										>
											<span className="block truncate text-sm font-semibold leading-tight tracking-[-0.01em] text-foreground md:text-[14.5px]">
												{currentTrack.title}
											</span>
											<p className="mt-1 flex items-center gap-1.5 truncate text-xs leading-tight text-muted-foreground">
												<AnimatePresence initial={false}>
													{audible && (
														<motion.span
															key="eq"
															initial={{ width: 0, opacity: 0 }}
															animate={{ width: "auto", opacity: 1 }}
															exit={{ width: 0, opacity: 0 }}
															transition={{ duration: 0.3, ease: EASE.emphasized }}
															className="inline-flex shrink-0 overflow-hidden"
														>
															<Equalizer playing className="h-3 text-primary" />
														</motion.span>
													)}
												</AnimatePresence>
												<ArtistLink id={currentTrack.artistId} name={currentTrack.artist} onClick={leavePlayer} className="truncate transition-colors hover:text-foreground" />
												<PlayingOn className="shrink-0 before:mr-0.5 before:text-muted-foreground before:content-['·']" />
											</p>
										</motion.div>
									</AnimatePresence>
								</div>
								{isAuthenticated && (
									<SaveButton
										className="size-8 shrink-0 text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground [&_svg]:size-[18px]"
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

							{/* Transport + seek (the bar sits under the buttons from md up) */}
							<div className="flex shrink-0 flex-col items-center md:gap-0.5">
								<div className="flex items-center justify-center gap-0.5 sm:gap-1">
									{hasQueue && (
										<Tip
											label={shuffle ? "Shuffle on" : "Shuffle"}
											trigger={
												<button
													type="button"
													aria-label="Shuffle"
													aria-pressed={shuffle}
													className={cn(ctl, "relative hidden size-8 md:inline-flex", shuffle && ctlOn)}
													onClick={toggleShuffle}
												/>
											}
										>
											<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="size-4">
												<path d="M16 3h5v5M4 20 21 3M21 16v5h-5M15 15l6 6M4 4l5 5" />
											</svg>
										</Tip>
									)}
									<Tip label="Previous track" trigger={<button type="button" aria-label="Previous track" className={cn(ctl, "hidden size-9 text-foreground md:inline-flex")} onClick={prev} />}>
										<PrevGlyph />
									</Tip>
									<span className="relative inline-flex size-12 items-center justify-center">
										<Tip
											label={isPlaying ? "Pause" : "Play"}
											trigger={
												<motion.button
													type="button"
													aria-label={isPlaying ? "Pause" : "Play"}
													initial={false}
													// Squircle when paused, circle when playing (M3 expressive).
													animate={{ borderRadius: isPlaying ? 21 : 13 }}
													whileTap={{ scale: 0.88 }}
													transition={{ borderRadius: { duration: 0.3, ease: EASE.emphasized }, scale: SPRING.press }}
													className="relative inline-flex size-[42px] items-center justify-center bg-foreground text-background shadow-[0_6px_16px_-6px_rgb(0_0_0/0.5)] outline-none transition-colors hover:bg-foreground/85 focus-visible:ring-2 focus-visible:ring-ring/50"
													onClick={toggle}
												/>
											}
										>
											<PlayPauseIcon playing={isPlaying} className="size-5" />
										</Tip>
										<BufferRing show={isPlaying && isBuffering} className="inset-0 size-12" />
									</span>
									<Tip label="Next track" trigger={<button type="button" aria-label="Next track" className={cn(ctl, "size-10 text-foreground md:size-9")} onClick={next} />}>
										<NextGlyph className="size-5 md:size-[18px]" />
									</Tip>
									{hasQueue && (
										<Tip
											label={repeat === "off" ? "Repeat" : repeat === "all" ? "Repeat all" : "Repeat one"}
											trigger={
												<button
													type="button"
													aria-label={`Repeat ${repeat}`}
													aria-pressed={repeat !== "off"}
													className={cn(ctl, "relative hidden size-8 md:inline-flex", repeat !== "off" && ctlOn)}
													onClick={toggleRepeat}
												/>
											}
										>
											<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="size-4">
												<path d="m17 2 4 4-4 4M3 11V10a4 4 0 0 1 4-4h14M7 22l-4-4 4-4M21 13v1a4 4 0 0 1-4 4H3" />
											</svg>
											{repeat === "one" && (
												<span className="absolute -right-0.5 -top-0.5 flex size-3.5 items-center justify-center rounded-full bg-primary text-[8px] font-semibold text-primary-foreground">1</span>
											)}
										</Tip>
									)}
								</div>
								<SeekBar
									currentTime={currentTime}
									duration={duration}
									buffered={buffered}
									loading={isPlaying && isBuffering}
									onSeek={seek}
									showTimes
									className="hidden w-[clamp(240px,30vw,400px)] md:flex"
								/>
							</div>

							{/* Secondary */}
							<div className="hidden min-w-0 items-center justify-end gap-1 md:flex">
								<Tip
									label={queuePanelOpen ? "Close queue" : `Queue (${queue.length})`}
									trigger={
										<button
											type="button"
											aria-label={queuePanelOpen ? "Close queue" : "Open queue"}
											aria-pressed={queuePanelOpen}
											className={cn(ctl, "relative size-9", queuePanelOpen && ctlOn)}
											onClick={handleToggleQueue}
										/>
									}
								>
									<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="size-[18px]">
										<path d="M8 6h13M8 12h13M8 18h9" />
										<circle cx="3.5" cy="6" r="1" fill="currentColor" />
										<circle cx="3.5" cy="12" r="1" fill="currentColor" />
										<circle cx="3.5" cy="18" r="1" fill="currentColor" />
									</svg>
									{queue.length > 1 && (
										<span
											aria-hidden
											className={cn(
												"absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[9px] font-semibold leading-none tabular-nums ring-2 ring-background",
												queuePanelOpen ? "bg-foreground text-background" : "bg-primary text-primary-foreground"
											)}
										>
											{queue.length > 99 ? "99+" : queue.length}
										</span>
									)}
								</Tip>

								<Tip
									label={lyricsVisible ? "Hide lyrics" : "Show lyrics"}
									trigger={
										<button
											type="button"
											aria-label="Toggle lyrics"
											aria-pressed={lyricsVisible}
											className={cn(ctl, "size-9", lyricsVisible && ctlOn)}
											onClick={handleToggleLyrics}
										/>
									}
								>
									<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="size-[18px]" aria-hidden>
										<path d="M4 5h11M4 10h8M4 15h6" />
										<path d="M14 19.5V12l6-1.5v7" />
										<circle cx="12.5" cy="19.5" r="1.5" />
										<circle cx="18.5" cy="17.5" r="1.5" />
									</svg>
								</Tip>

								<DevicePicker className={cn(ctl, "size-9 data-popup-open:bg-foreground/[0.06] data-popup-open:text-foreground")} />

								<VolumeControl />

								{/* Less-used actions. Native title: nested Tooltip + Menu triggers swallow clicks. */}
								<DropdownMenu>
									<DropdownMenuTrigger aria-label="More player options" title="More" className={cn(ctl, "size-9 data-popup-open:bg-foreground/[0.06] data-popup-open:text-foreground")}>
										<MoreHorizontal className="size-[18px]" />
									</DropdownMenuTrigger>
									<DropdownMenuContent side="top" align="end" sideOffset={16} className="w-60 rounded-2xl p-1.5">
										<DropdownMenuItem onClick={handleDownload} className="gap-2.5 rounded-xl px-2.5 py-2">
											<DownloadGlyph />
											Download track
										</DropdownMenuItem>
										<DropdownMenuSeparator />
										<DropdownMenuGroup>
											<DropdownMenuLabel className="flex items-center gap-2 px-2.5 text-[11px] font-semibold uppercase tracking-[0.12em] text-primary">
												<SlidersHorizontal className="size-3.5" />
												Crossfade
											</DropdownMenuLabel>
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
														{s === 0 ? "off" : `${s}s`}
													</button>
												))}
											</div>
										</DropdownMenuGroup>
										<DropdownMenuCheckboxItem checked={normalizationEnabled} onClick={toggleNormalization} className="rounded-xl py-2">
											Loudness normalization
										</DropdownMenuCheckboxItem>
										<GaplessMenuItem on={gapless} crossfade={crossfadeDuration > 0} onToggle={toggleGapless} />
										<DropdownMenuSeparator />
										<DropdownMenuItem onClick={stop} variant="destructive" className="gap-2.5 rounded-xl px-2.5 py-2">
											<X className="size-4" />
											Close player
										</DropdownMenuItem>
									</DropdownMenuContent>
								</DropdownMenu>
							</div>

							{/* Phones: the wavy progress line rides along the card's bottom edge. */}
							<WaveSeek
								currentTime={currentTime}
								duration={duration}
								buffered={buffered}
								playing={audible}
								onSeek={seek}
								height={10}
								stroke={3}
								amplitude={2}
								wavelength={18}
								showTimes={false}
								thumb={false}
								tone="primary"
								trackClassName="text-foreground/10"
								className="absolute inset-x-4 bottom-1 md:hidden"
							/>
						</div>
					</CoverTheme>
				</motion.div>
			)}
		</AnimatePresence>
	);
}
