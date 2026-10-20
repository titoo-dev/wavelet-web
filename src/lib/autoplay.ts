// Autoplay: when the queue runs out, more of the same. Candidates come from
// Deezer's artist radios (the seed artist mixed with similar ones); the
// user's own listening log decides what to leave out. Fetching lives in the
// route (POST /api/v1/autoplay); everything here is pure.

/** A track as the player queues it (PlayerTrack). */
export interface AutoplayTrack {
	trackId: string;
	title: string;
	artist: string;
	artistId: string | null;
	album: string | null;
	albumId: string | null;
	cover: string | null;
	duration: number | null;
}

/** What the listening log says about this user. */
export interface TasteSignals {
	/** Tracks skipped early more often than listened to. */
	skippedTracks: Set<string>;
	/** Artists skipped early again and again, never listened to. */
	skippedArtists: Set<string>;
	/** Tracks played a short while ago: not again so soon. */
	recentTracks: Set<string>;
}

export const EMPTY_SIGNALS: TasteSignals = {
	skippedTracks: new Set(),
	skippedArtists: new Set(),
	recentTracks: new Set(),
};

/** Listened to for less than this: an early skip. */
export const EARLY_SKIP_MS = 30_000;
/** Early skips (and no real listen) that rule an artist out. */
export const ARTIST_SKIPS_TO_DROP = 3;
/** A track played within this window is not offered again. */
export const RECENT_MS = 3 * 60 * 60 * 1000;

export interface ListenRow {
	trackId: string;
	artistId: string | null;
	endReason: string;
	msPlayed: number;
	startedAt: Date;
}

/** Reads the user's recent listens into [TasteSignals]. */
export function signalsFrom(listens: ListenRow[], now: number): TasteSignals {
	const tracks = new Map<string, { early: number; heard: number }>();
	const artists = new Map<string, { early: number; heard: number }>();
	const recentTracks = new Set<string>();
	const bump = (m: Map<string, { early: number; heard: number }>, key: string, early: boolean) => {
		const c = m.get(key) ?? { early: 0, heard: 0 };
		if (early) c.early++;
		else c.heard++;
		m.set(key, c);
	};
	for (const l of listens) {
		if (now - l.startedAt.getTime() <= RECENT_MS) recentTracks.add(l.trackId);
		// A failed or transferred play says nothing about taste.
		if (l.endReason === "failed" || l.endReason === "transferred") continue;
		const early = l.endReason === "skipped" && l.msPlayed < EARLY_SKIP_MS;
		const heard = l.endReason === "completed" || l.msPlayed >= EARLY_SKIP_MS;
		if (!early && !heard) continue;
		bump(tracks, l.trackId, early);
		if (l.artistId) bump(artists, l.artistId, early);
	}
	const skippedTracks = new Set([...tracks].filter(([, c]) => c.early > c.heard).map(([id]) => id));
	const skippedArtists = new Set(
		[...artists].filter(([, c]) => c.early >= ARTIST_SKIPS_TO_DROP && c.heard === 0).map(([id]) => id)
	);
	return { skippedTracks, skippedArtists, recentTracks };
}

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});
const text = (v: unknown): string | null => (typeof v === "string" && v ? v : typeof v === "number" ? String(v) : null);

/** A track from Deezer's public API (`artist/{id}/radio`); null when it can't be played. */
export function fromApiTrack(raw: unknown): AutoplayTrack | null {
	const t = obj(raw);
	const trackId = text(t.id);
	const title = text(t.title);
	if (!trackId || !title || t.readable === false) return null;
	const artist = obj(t.artist);
	const album = obj(t.album);
	return {
		trackId,
		title,
		artist: text(artist.name) ?? "",
		artistId: text(artist.id),
		album: text(album.title),
		albumId: text(album.id),
		cover: text(album.cover_medium) ?? text(album.cover_big) ?? text(album.cover),
		duration: typeof t.duration === "number" && t.duration > 0 ? t.duration : null,
	};
}

/** The same song under another id (a re-release, a deluxe edition). */
const songKey = (t: AutoplayTrack) => `${t.artist.toLowerCase()}\u0000${t.title.toLowerCase().replace(/\s*[([].*$/, "")}`;

export interface PickOptions {
	/** Track ids already in the queue. */
	exclude: Set<string>;
	signals: TasteSignals;
	limit: number;
	/** Most tracks of one artist in one batch. */
	maxPerArtist?: number;
}

/**
 * Up to `limit` tracks from the candidate lists, taken in turns (the first
 * list — the most recent seed — leads every round): nothing already queued,
 * skipped, played just now or by a skipped artist, at most `maxPerArtist` per
 * artist, and never the same artist twice in a row when it can be helped.
 */
export function pickAutoplay(lists: AutoplayTrack[][], opts: PickOptions): AutoplayTrack[] {
	const { exclude, signals, limit } = opts;
	const maxPerArtist = opts.maxPerArtist ?? 2;
	const seenIds = new Set<string>();
	const seenSongs = new Set<string>();
	const perArtist = new Map<string, number>();
	const picked: AutoplayTrack[] = [];
	const cursors = lists.map(() => 0);

	const accept = (t: AutoplayTrack): boolean => {
		if (exclude.has(t.trackId) || seenIds.has(t.trackId)) return false;
		if (signals.skippedTracks.has(t.trackId) || signals.recentTracks.has(t.trackId)) return false;
		const artistKey = t.artistId ?? t.artist.toLowerCase();
		if (t.artistId && signals.skippedArtists.has(t.artistId)) return false;
		if ((perArtist.get(artistKey) ?? 0) >= maxPerArtist) return false;
		const song = songKey(t);
		if (seenSongs.has(song)) return false;
		seenIds.add(t.trackId);
		seenSongs.add(song);
		perArtist.set(artistKey, (perArtist.get(artistKey) ?? 0) + 1);
		return true;
	};

	let progressed = true;
	while (picked.length < limit && progressed) {
		progressed = false;
		for (let i = 0; i < lists.length && picked.length < limit; i++) {
			const list = lists[i];
			while (cursors[i] < list.length) {
				const t = list[cursors[i]++];
				progressed = true;
				if (accept(t)) {
					picked.push(t);
					break;
				}
			}
		}
	}
	return spreadArtists(picked);
}

/** Reorders so that one artist doesn't play twice in a row, when another can go between. */
export function spreadArtists(tracks: AutoplayTrack[]): AutoplayTrack[] {
	const rest = tracks.slice();
	const out: AutoplayTrack[] = [];
	const key = (t: AutoplayTrack) => t.artistId ?? t.artist.toLowerCase();
	while (rest.length > 0) {
		const last = out.at(-1);
		const i = last ? rest.findIndex((t) => key(t) !== key(last)) : 0;
		out.push(rest.splice(i === -1 ? 0 : i, 1)[0]);
	}
	return out;
}
