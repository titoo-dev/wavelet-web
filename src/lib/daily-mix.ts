// The Daily Mix (home): the user's taste of the day. Three of their top
// artists, a different three each day, give the mix its colour: about a third
// is tracks the user already loves by them, the rest are discoveries from
// those artists' Deezer radios. With no history yet, Deezer's own Flow for
// the user's account stands in. Fetching and caching live in the route
// (GET /api/v1/mixes/daily); everything here is pure.

import { EARLY_SKIP_MS, pickAutoplay, spreadArtists, type AutoplayTrack, type ListenRow, type TasteSignals } from "./autoplay";

export const MIX_SIZE = 30;
/** Share of the mix taken from tracks the user already loves. */
export const FAMILIAR_SHARE = 1 / 3;
export const SEEDS_PER_DAY = 3;
/** The top artists the seeds of the day rotate through. */
export const SEED_POOL = 9;
/** A followed artist weighs this many listens. */
export const FOLLOW_WEIGHT = 5;

export interface DailyMix {
	/** YYYY-MM-DD, the user's day. */
	day: string;
	/** taste: built from the user's top artists; flow: Deezer's Flow (no history yet). */
	basedOn: "taste" | "flow";
	/** The seed artists' names ("Daft Punk, Justice and Kavinsky"). */
	artists: string[];
	tracks: AutoplayTrack[];
}

export interface ArtistScore {
	artistId: string;
	name: string | null;
	score: number;
}

/**
 * The user's artists, best first: a listen heard counts 1 (2 when it ran to
 * its end), an early skip -1, following the artist FOLLOW_WEIGHT. Artists
 * at 0 or below are left out.
 */
export function topArtists(listens: ListenRow[], followed: { deezerArtistId: string; name: string }[]): ArtistScore[] {
	const scores = new Map<string, ArtistScore>();
	const add = (artistId: string, name: string | null, n: number) => {
		const s = scores.get(artistId) ?? { artistId, name: null, score: 0 };
		s.score += n;
		s.name ??= name;
		scores.set(artistId, s);
	};
	for (const l of listens) {
		if (!l.artistId || l.endReason === "failed" || l.endReason === "transferred") continue;
		if (l.endReason === "completed") add(l.artistId, null, 2);
		else if (l.msPlayed >= EARLY_SKIP_MS) add(l.artistId, null, 1);
		else if (l.endReason === "skipped") add(l.artistId, null, -1);
	}
	for (const f of followed) add(f.deezerArtistId, f.name, FOLLOW_WEIGHT);
	return [...scores.values()].filter((s) => s.score > 0).sort((a, b) => b.score - a.score || a.artistId.localeCompare(b.artistId));
}

/** Days since 1970-01-01 for a YYYY-MM-DD day. */
export function dayNumber(day: string): number {
	return Math.floor(Date.parse(`${day}T00:00:00Z`) / 86_400_000);
}

/** The seeds of the day: a window of SEEDS_PER_DAY moving through the top SEED_POOL artists, day after day. */
export function seedsOfDay(top: ArtistScore[], day: string): ArtistScore[] {
	const pool = top.slice(0, SEED_POOL);
	if (pool.length <= SEEDS_PER_DAY) return pool;
	const start = (((dayNumber(day) * SEEDS_PER_DAY) % pool.length) + pool.length) % pool.length;
	return Array.from({ length: SEEDS_PER_DAY }, (_, i) => pool[(start + i) % pool.length]);
}

function hash(s: string): number {
	let h = 2166136261;
	for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
	return h >>> 0;
}

/** The same order for the same seed (one user, one day), a different one the next day. */
export function seededShuffle<T>(items: T[], seed: string): T[] {
	let state = hash(seed) || 1;
	const random = () => {
		// mulberry32
		state = (state + 0x6d2b79f5) | 0;
		let t = Math.imul(state ^ (state >>> 15), 1 | state);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
	const out = items.slice();
	for (let i = out.length - 1; i > 0; i--) {
		const j = Math.floor(random() * (i + 1));
		[out[i], out[j]] = [out[j], out[i]];
	}
	return out;
}

const norm = (s: string) => s.trim().toLowerCase();

export interface MixInput {
	/** Tracks the user already loves (liked, played): those by a seed artist go in. */
	familiar: AutoplayTrack[];
	/** The seed artists' names. */
	seedNames: string[];
	/** The seed artists' radios, in seed order. */
	radios: AutoplayTrack[][];
	signals: TasteSignals;
	/** Makes the day's picks stable: user id + day. */
	seed: string;
	size?: number;
}

/**
 * The mix: about FAMILIAR_SHARE of loved tracks by the seed artists (shuffled
 * for the day), the rest discoveries from their radios (nothing the user
 * already has, skips left out, at most 3 per artist), a loved track every
 * third, then spread so that one artist doesn't play twice in a row.
 */
export function buildDailyMix({ familiar, seedNames, radios, signals, seed, size = MIX_SIZE }: MixInput): AutoplayTrack[] {
	const names = new Set(seedNames.map(norm));
	const known = new Set(familiar.map((t) => t.trackId));
	const seen = new Set<string>();
	const loved = seededShuffle(
		familiar.filter((t) => {
			if (!names.has(norm(t.artist)) || signals.skippedTracks.has(t.trackId) || seen.has(t.trackId)) return false;
			seen.add(t.trackId);
			return true;
		}),
		seed
	).slice(0, Math.round(size * FAMILIAR_SHARE));
	const discoveries = pickAutoplay(
		radios.map((r) => seededShuffle(r, seed)),
		{ exclude: known, signals: { ...signals, recentTracks: new Set() }, limit: size - loved.length, maxPerArtist: 3 }
	);
	const out: AutoplayTrack[] = [];
	let l = 0;
	let d = 0;
	while (l < loved.length || d < discoveries.length) {
		const lovedTurn = (out.length % 3 === 2 && l < loved.length) || d >= discoveries.length;
		out.push(lovedTurn ? loved[l++] : discoveries[d++]);
	}
	return spreadArtists(out);
}

/** With no history: Deezer's Flow for the user's account, skips left out. */
export function flowMix(flow: AutoplayTrack[], signals: TasteSignals, size = MIX_SIZE): AutoplayTrack[] {
	return pickAutoplay([flow], { exclude: new Set(), signals: { ...signals, recentTracks: new Set() }, limit: size, maxPerArtist: 3 });
}
