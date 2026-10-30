"use client";

import { useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Headphones, RotateCcw, SlidersVertical } from "lucide-react";
import { usePlayerStore } from "@/stores/usePlayerStore";
import { cn } from "@/lib/utils";
import { DUR, FilterPills, SlidingSegments } from "@/components/expressive";
import { EQ_BANDS, EQ_MAX_DB, EQ_PRESET_IDS, eqGains, isEqActive, type EqPresetId, type SpatialMode } from "@/components/audio/engine/sound";
import { SettingsTile, TilePanel } from "./SettingsTiles";

// ─── Spatial sound ─────────────────────────────────────────────────────────

const SPATIAL_LABEL: Record<SpatialMode, string> = { off: "Off", studio: "Studio", room: "Room", hall: "Hall" };

const SPATIAL_DETAIL: Record<SpatialMode, string> = {
	off: "Off: the sound stays inside your head, as mixed.",
	studio: "Each ear hears a little of the other, like speakers in front of you.",
	room: "Speakers in a small room around you.",
	hall: "A large, airy hall around you.",
};

function ValuePill({ on, label }: { on: boolean; label: string }) {
	return (
		<span className={cn("inline-flex h-8 min-w-12 items-center justify-center rounded-full px-3 text-sm font-semibold transition-colors duration-300", on ? "bg-tertiary-container text-on-tertiary-container" : "bg-surface-highest text-muted-foreground")}>
			<AnimatePresence mode="popLayout" initial={false}>
				<motion.span key={label} initial={{ scale: 0.8, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.8, opacity: 0 }} transition={{ duration: DUR.short }}>
					{label}
				</motion.span>
			</AnimatePresence>
		</span>
	);
}

/** Headphone spatialisation (crossfeed, then a synthetic room): segmented modes. */
export function SpatialTile() {
	const spatial = usePlayerStore((s) => s.sound.spatial);
	const setSpatial = usePlayerStore((s) => s.setSpatial);
	const on = spatial !== "off";
	return (
		<SettingsTile icon={Headphones} title="Spatial sound" tone={on ? "primary" : "muted"} subtitle={SPATIAL_DETAIL[spatial]} trailing={<ValuePill on={on} label={SPATIAL_LABEL[spatial]} />}>
			<div className="px-4 pb-4">
				<SlidingSegments id="spatial" size="sm" value={spatial} onChange={setSpatial} items={(Object.keys(SPATIAL_LABEL) as SpatialMode[]).map((m) => ({ value: m, label: SPATIAL_LABEL[m] }))} />
				<p className="mt-2 px-1 text-xs leading-relaxed text-muted-foreground">Made for headphones. Applies to this device only.</p>
			</div>
		</SettingsTile>
	);
}

// ─── Equalizer ─────────────────────────────────────────────────────────────

const PRESET_LABEL: Record<EqPresetId, string> = {
	flat: "Flat",
	bass: "Bass",
	vocal: "Vocal",
	acoustic: "Acoustic",
	bright: "Bright",
	loudness: "Loudness",
	custom: "Custom",
};

const bandLabel = (hz: number) => (hz >= 1000 ? `${hz / 1000}k` : String(hz));
const dbLabel = (db: number) => (db > 0 ? `+${db}` : String(db));

/** 10-band equaliser: preset pills, then one vertical slider per band (moving one makes the curve custom). */
export function EqualizerTile() {
	const sound = usePlayerStore((s) => s.sound);
	const setEqPreset = usePlayerStore((s) => s.setEqPreset);
	const setEqBand = usePlayerStore((s) => s.setEqBand);
	const [open, setOpen] = useState(false);
	const gains = eqGains(sound);
	const on = isEqActive(sound);

	return (
		<SettingsTile
			icon={SlidersVertical}
			title="Equalizer"
			tone={on ? "primary" : "muted"}
			subtitle={on ? `${PRESET_LABEL[sound.eqPreset]} curve` : "Flat: the sound as mastered."}
			trailing={<ValuePill on={on} label={on ? PRESET_LABEL[sound.eqPreset] : "Off"} />}
			chevron
			expanded={open}
			onClick={() => setOpen((o) => !o)}
		>
			<TilePanel open={open} className="space-y-4">
				<FilterPills ariaLabel="Equalizer preset" value={sound.eqPreset} onChange={setEqPreset} items={EQ_PRESET_IDS.map((id) => ({ value: id, label: PRESET_LABEL[id] }))} />
				<div className="rounded-[20px] bg-surface-high px-2 py-3">
					<div className="grid grid-cols-10 gap-0.5">
						{EQ_BANDS.map((hz, i) => (
							<label key={hz} className="flex min-w-0 flex-col items-center gap-1.5">
								<span className={cn("font-mono text-[11px] tabular-nums transition-colors", gains[i] === 0 ? "text-muted-foreground" : "font-semibold text-primary")}>{dbLabel(gains[i])}</span>
								<input
									type="range"
									min={-EQ_MAX_DB}
									max={EQ_MAX_DB}
									step={0.5}
									value={gains[i]}
									aria-label={`${bandLabel(hz)} Hz`}
									aria-valuetext={`${dbLabel(gains[i])} dB`}
									onChange={(e) => setEqBand(i, Number(e.target.value))}
									className="eq-slider h-36 w-6 cursor-pointer accent-primary"
								/>
								<span className="text-[11px] text-muted-foreground">{bandLabel(hz)}</span>
							</label>
						))}
					</div>
				</div>
				<div className="flex items-center justify-between gap-3 px-1">
					<p className="text-xs leading-relaxed text-muted-foreground">±{EQ_MAX_DB} dB per band. Boosts are balanced so nothing clips.</p>
					<motion.button
						type="button"
						whileTap={{ scale: 0.95 }}
						disabled={sound.eqPreset === "flat"}
						onClick={() => setEqPreset("flat")}
						className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full px-3 text-sm font-semibold text-primary transition-[background-color,opacity] hover:bg-primary/10 disabled:opacity-40"
					>
						<RotateCcw className="size-4" />
						Reset
					</motion.button>
				</div>
			</TilePanel>
		</SettingsTile>
	);
}
