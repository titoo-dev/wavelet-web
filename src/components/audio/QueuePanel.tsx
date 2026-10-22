"use client";

import { useEffect, useState } from "react";
import { motion, AnimatePresence, Reorder, useDragControls } from "motion/react";
import { CoverImage } from "@/components/ui/cover-image";
import { ArtistLink } from "@/components/links/EntityLink";
import { leavePlayer } from "./leave-player";
import { ScrollArea } from "@/components/ui/scroll-area";
import { usePlayerStore, type PlayerTrack } from "@/stores/usePlayerStore";
import { GripVertical, ListMusic, Shuffle, Sparkles, X, Trash2 } from "lucide-react";
import { Equalizer } from "@/components/motion/icons";
import { CountPill, CoverTheme, Medallion, entrance } from "@/components/expressive";
import { PlaybackIndicator } from "./PlaybackIndicator";
import { cn } from "@/lib/utils";
import { useScrollerRows } from "@/hooks/useVirtualRows";
import { toast } from "sonner";

/** Floating panel shell shared by the queue and the lyrics (rounded 28, surfaceContainer). */
export const floatingPanel =
	"fixed z-[60] flex flex-col overflow-hidden rounded-[28px] bg-surface-container text-foreground shadow-popover inset-x-2 top-[calc(env(safe-area-inset-top,0px)+8px)] md:inset-x-auto md:right-4 md:top-[calc(var(--header-h)+12px)] md:bottom-[calc(var(--player-h)+var(--player-offset)+12px)] md:w-[380px]";

export function QueuePanel() {
	const open = usePlayerStore((s) => s.queuePanelOpen);
	const setOpen = usePlayerStore((s) => s.setQueuePanelOpen);
	const queue = usePlayerStore((s) => s.queue);
	const queueIndex = usePlayerStore((s) => s.queueIndex);
	const isPlaying = usePlayerStore((s) => s.isPlaying);
	const shuffle = usePlayerStore((s) => s.shuffle);
	const jumpToIndex = usePlayerStore((s) => s.jumpToIndex);
	const moveInQueue = usePlayerStore((s) => s.moveInQueue);
	const removeFromQueue = usePlayerStore((s) => s.removeFromQueue);
	const clearQueue = usePlayerStore((s) => s.clearQueue);
	const currentTrack = usePlayerStore((s) => s.currentTrack);
	// Over Now Playing there's no docked player to clear on phones.
	const overFullscreen = usePlayerStore((s) => s.fullscreenOpen);

	const [isDesktop, setIsDesktop] = useState(() =>
		typeof window !== "undefined" &&
		window.matchMedia("(min-width: 768px)").matches
	);
	useEffect(() => {
		const mq = window.matchMedia("(min-width: 768px)");
		const handler = (e: MediaQueryListEvent) => setIsDesktop(e.matches);
		mq.addEventListener("change", handler);
		return () => mq.removeEventListener("change", handler);
	}, []);

	// Mobile-only drag-to-dismiss: scoped via useDragControls so only the top
	// handle bar starts a drag. Below 120px / 500px·s⁻¹ snaps back to the
	// resting position; above either threshold dismisses the panel.
	const dragControls = useDragControls();
	const handleDragEnd = (
		_: unknown,
		info: { offset: { y: number }; velocity: { y: number } }
	) => {
		if (info.offset.y > 120 || info.velocity.y > 500) {
			setOpen(false);
		}
	};

	// Escape: useKeyboardShortcuts closes the top-most player layer only (was: one Escape closed the palette and this panel).

	if (!currentTrack) return null;

	const current = queueIndex >= 0 ? queue[queueIndex] : null;
	const played = queueIndex > 0 ? queue.slice(0, queueIndex) : [];
	const upNext = queueIndex >= 0 ? queue.slice(queueIndex + 1) : [];

	// Reorder.Group passes us the new order of trackIds. Diff against the
	// previous order to find the moved item, then call moveInQueue with
	// absolute indices (the panel only reorders the "Up Next" slice).
	const handleReorder = (newIds: string[]) => {
		const oldIds = upNext.map((t) => t.trackId);
		for (let i = 0; i < newIds.length; i++) {
			if (oldIds[i] !== newIds[i]) {
				const movedId = oldIds[i];
				const newPos = newIds.indexOf(movedId);
				if (newPos >= 0 && newPos !== i) {
					moveInQueue(queueIndex + 1 + i, queueIndex + 1 + newPos);
				}
				break;
			}
		}
	};

	const totalCount = queue.length;
	const subtitle = totalCount === 0 ? "" : totalCount === 1 ? "1 track" : `${totalCount} tracks`;

	return (
		<AnimatePresence>
			{open && (
				<motion.aside
					key="queue-panel"
					initial={isDesktop ? { x: 24, opacity: 0, scale: 0.98 } : { y: "100%", opacity: 0 }}
					animate={isDesktop ? { x: 0, opacity: 1, scale: 1 } : { y: 0, opacity: 1 }}
					exit={isDesktop ? { x: 24, opacity: 0, scale: 0.98 } : { y: "100%", opacity: 0 }}
					transition={{ type: "spring", damping: 32, stiffness: 360 }}
					style={{ transformOrigin: "right center" }}
					drag={isDesktop ? false : "y"}
					dragControls={dragControls}
					dragListener={false}
					dragConstraints={{ top: 0, bottom: 0 }}
					dragElastic={{ top: 0, bottom: 0.4 }}
					onDragEnd={handleDragEnd}
					role="region"
					aria-label="Queue"
					className={cn(
						floatingPanel,
						overFullscreen ? "bottom-[calc(env(safe-area-inset-bottom,0px)+8px)]" : "bottom-[calc(var(--player-h)+var(--player-offset)+8px)]"
					)}
				>
					{/* Drag handle (mobile only) — scoped drag surface, also signals "swipeable" */}
					{!isDesktop && (
						<div
							onPointerDown={(e) => dragControls.start(e)}
							role="button"
							aria-label="Drag down to close queue"
							className="flex shrink-0 cursor-grab touch-none items-center justify-center pb-1 pt-2.5 active:cursor-grabbing"
						>
							<div className="h-1 w-9 rounded-full bg-foreground/20" />
						</div>
					)}

					{/* Header */}
					<div className="flex items-center gap-2 px-5 pb-3 pt-3 md:pt-5">
						<div className="min-w-0 flex-1">
							<h2 className="text-2xl font-semibold leading-tight tracking-[-0.02em]">Queue</h2>
							<div className="mt-1 flex items-center gap-2">
								<span className="truncate text-sm text-muted-foreground tabular-nums">{subtitle}</span>
								<AnimatePresence>
									{shuffle && (
										<motion.span
											initial={{ opacity: 0, scale: 0.6 }}
											animate={{ opacity: 1, scale: 1 }}
											exit={{ opacity: 0, scale: 0.6 }}
											transition={{ type: "spring", stiffness: 520, damping: 18 }}
											className="inline-flex h-6 items-center gap-1 rounded-full bg-primary-container px-2.5 text-[11px] font-semibold text-on-primary-container"
										>
											<Shuffle className="size-3" strokeWidth={2.5} />
											Shuffled
										</motion.span>
									)}
								</AnimatePresence>
							</div>
						</div>
						{queue.length > 1 && (
							<button
								type="button"
								onClick={() => {
									const removed = queue.length - 1;
									clearQueue();
									toast.success(`Cleared ${removed} ${removed === 1 ? "track" : "tracks"} from queue`, { duration: 3000 });
								}}
								className="inline-flex h-9 items-center gap-1.5 rounded-full px-3.5 text-sm font-semibold text-primary transition-colors hover:bg-primary/10 active:scale-95 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/30"
								aria-label="Clear queue"
							>
								<Trash2 className="size-4" />
								Clear
							</button>
						)}
						<button
							type="button"
							onClick={() => setOpen(false)}
							aria-label="Close queue"
							className="-mr-1.5 inline-flex size-10 items-center justify-center rounded-full bg-surface-high text-foreground transition-colors hover:bg-surface-highest active:scale-90 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/30"
						>
							<X className="size-[18px]" />
						</button>
					</div>

					{/* Body */}
					<ScrollArea className="min-h-0 flex-1">
						<div className="space-y-6 px-3 pb-4 pt-1">
							{current && <NowCard track={current} isPlaying={isPlaying} />}

							{upNext.length > 0 && (
								<section>
									<SectionLabel count={upNext.length}>Up next</SectionLabel>
									<UpNextList
										tracks={upNext}
										onReorder={handleReorder}
										onJump={(i) => jumpToIndex(queueIndex + 1 + i)}
										onRemove={(i) => removeFromQueue(queueIndex + 1 + i)}
									/>
								</section>
							)}

							{played.length > 0 && (
								<section>
									<SectionLabel count={played.length}>History</SectionLabel>
									<HistoryList tracks={played} onJump={jumpToIndex} />
								</section>
							)}

							{queue.length <= 1 && (
								<Medallion icon={ListMusic} title="Nothing up next" message="Add tracks to fill your queue." className="py-8" />
							)}
						</div>
					</ScrollArea>

					{/* Footer */}
					{upNext.length > 1 && (
						<div className="flex items-center justify-center gap-1.5 px-4 pb-3 pt-1 text-xs text-muted-foreground">
							<GripVertical className="size-3.5" />
							Drag to reorder
						</div>
					)}
				</motion.aside>
			)}
		</AnimatePresence>
	);
}

// Queue rows scroll inside the panel's ScrollArea viewport.
const viewportOf = (list: HTMLElement) => list.closest("[data-slot=\"scroll-area-viewport\"]");
const QUEUE_ROW = 60;
const queueRowSize = () => QUEUE_ROW;

/** Draggable "Up next" rows, virtualized for long queues. Motion's Reorder
 *  swaps within the full `values`, so unmounted rows keep their place. */
function UpNextList({
	tracks,
	onReorder,
	onJump,
	onRemove,
}: {
	tracks: PlayerTrack[];
	onReorder: (trackIds: string[]) => void;
	onJump: (i: number) => void;
	onRemove: (i: number) => void;
}) {
	const { listRef, rows, measureRef, style } = useScrollerRows({
		scroller: viewportOf,
		count: tracks.length,
		estimateSize: queueRowSize,
		getItemKey: (i) => tracks[i].trackId,
		gap: 4,
	});
	return (
		<Reorder.Group
			ref={listRef}
			axis="y"
			values={tracks.map((t) => t.trackId)}
			onReorder={onReorder}
			className="flex flex-col gap-1"
			style={style}
		>
			{rows.map(({ index: i }) => (
				<Reorder.Item
					key={tracks[i].trackId}
					ref={measureRef}
					data-index={i}
					value={tracks[i].trackId}
					className="cursor-grab rounded-2xl active:cursor-grabbing"
					whileDrag={{ scale: 1.02, boxShadow: "0 12px 28px -8px rgb(0 0 0 / 0.35)" }}
				>
					<QueueRow track={tracks[i]} index={i} onJump={() => onJump(i)} onRemove={() => onRemove(i)} showHandle />
				</Reorder.Item>
			))}
		</Reorder.Group>
	);
}

/** Already-played rows, virtualized for long sessions. */
function HistoryList({ tracks, onJump }: { tracks: PlayerTrack[]; onJump: (i: number) => void }) {
	const { listRef, rows, measureRef, style } = useScrollerRows({
		scroller: viewportOf,
		count: tracks.length,
		estimateSize: queueRowSize,
		getItemKey: (i) => `played-${i}-${tracks[i].trackId}`,
		gap: 4,
	});
	return (
		<div ref={listRef} className="flex flex-col gap-1 opacity-55 transition-opacity hover:opacity-80" style={style}>
			{rows.map(({ index: i, key }) => (
				<div key={key} ref={measureRef} data-index={i}>
					<QueueRow track={tracks[i]} index={i} onJump={() => onJump(i)} />
				</div>
			))}
		</div>
	);
}

/** "UP NEXT" / "HISTORY": primary eyebrow + count pill. */
function SectionLabel({ children, count }: { children: React.ReactNode; count: number }) {
	return (
		<h3 className="mb-2 flex items-center gap-2 px-2">
			<span className="type-eyebrow text-primary">{children}</span>
			<CountPill value={count} />
		</h3>
	);
}

/** The cover-themed "now playing" card (radius 24, tonal gradient, 64px art). */
function NowCard({ track, isPlaying }: { track: PlayerTrack; isPlaying: boolean }) {
	return (
		<CoverTheme src={track.cover}>
			<motion.div
				layout
				className="flex items-center gap-3.5 rounded-[24px] bg-[linear-gradient(135deg,var(--m3-primary-container),var(--m3-tertiary-container))] p-3 text-on-primary-container shadow-[0_8px_22px_-8px_color-mix(in_oklch,var(--m3-primary)_45%,transparent)]"
			>
				<div className="relative shrink-0">
					<CoverImage src={track.cover} className="size-16 rounded-2xl shadow-[0_4px_12px_-2px_rgb(0_0_0/0.3)]" />
				</div>
				<div className="min-w-0 flex-1">
					<p className="type-eyebrow flex items-center gap-1.5 text-primary">
						{isPlaying && <Equalizer playing className="h-2.5" />}
						Now playing
					</p>
					<AnimatePresence mode="popLayout" initial={false}>
						<motion.div key={track.trackId} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }}>
							<p className="mt-1 truncate text-base font-semibold leading-tight tracking-[-0.01em]">{track.title}</p>
							<p className="mt-0.5 truncate text-sm text-on-primary-container/75">
								<ArtistLink id={track.artistId} name={track.artist} onClick={leavePlayer} className="transition-colors hover:text-on-primary-container" />
							</p>
						</motion.div>
					</AnimatePresence>
				</div>
			</motion.div>
		</CoverTheme>
	);
}

interface QueueRowProps {
	track: PlayerTrack;
	index: number;
	active?: boolean;
	isPlaying?: boolean;
	showHandle?: boolean;
	onJump?: () => void;
	onRemove?: () => void;
}

function QueueRow({ track, index, active, isPlaying, showHandle, onJump, onRemove }: QueueRowProps) {
	const interactive = !!onJump;
	return (
		<motion.div
			// Rows scrolled into a virtualized list rise in without the stagger delay.
			{...entrance(index < 12 ? index : 0, 8)}
			role={interactive ? "button" : undefined}
			tabIndex={interactive ? 0 : undefined}
			onClick={interactive ? onJump : undefined}
			onKeyDown={
				interactive
					? (e) => {
							if (e.key === "Enter" || e.key === " ") {
								e.preventDefault();
								onJump?.();
							}
						}
					: undefined
			}
			className={cn(
				"group flex select-none items-center gap-3 rounded-2xl px-2 py-1.5 transition-colors",
				active ? "bg-secondary" : "hover:bg-surface-high",
				interactive && "cursor-pointer focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/30"
			)}
		>
			<div className="relative shrink-0">
				<CoverImage src={track.cover} className="size-12 rounded-xl" />
				{active && (
					<div className="absolute inset-0 flex items-center justify-center rounded-xl bg-black/50 text-white">
						<PlaybackIndicator paused={!isPlaying} />
					</div>
				)}
			</div>

			<div className="min-w-0 flex-1">
				<p className={cn("truncate text-[15px] font-semibold leading-tight", active && "font-semibold text-primary")}>{track.title}</p>
				<p className="mt-0.5 flex items-center gap-1 truncate text-[13px] leading-tight text-muted-foreground">
					{track.source === "autoplay" && (
						<Sparkles className="size-3 shrink-0 text-primary" aria-label="Added by autoplay" role="img" />
					)}
					<ArtistLink id={track.artistId} name={track.artist} onClick={leavePlayer} className="truncate transition-colors hover:text-foreground" />
				</p>
			</div>

			{onRemove && (
				<button
					type="button"
					aria-label={`Remove ${track.title} from queue`}
					className="inline-flex size-8 shrink-0 items-center justify-center rounded-full text-muted-foreground opacity-0 transition-[opacity,background-color,color] hover:bg-destructive/10 hover:text-destructive focus:opacity-100 group-hover:opacity-100 max-md:opacity-100"
					onClick={(e) => {
						e.stopPropagation();
						onRemove();
					}}
				>
					<X className="size-4" />
				</button>
			)}
			{showHandle && (
				<span aria-hidden className="shrink-0 touch-none text-muted-foreground/40 transition-colors group-hover:text-muted-foreground">
					<GripVertical className="size-4" />
				</span>
			)}
		</motion.div>
	);
}
