// Similar tracks from outside Deezer, mapped back onto the Deezer catalogue:
//
// - ListenBrainz: Deezer ISRC → MusicBrainz recording (musicbrainz.org, no
//   key, 1 request/s) → similar recordings (labs.api.listenbrainz.org,
//   listening sessions of the ListenBrainz community, no key).
// - Last.fm: track.getSimilar by artist + title (LASTFM_API_KEY; skipped
//   without one).
//
// Each similar track (artist + title) is then looked up with a Deezer search.
// Everything is cached in memory for a day: the same seeds come back often.
// Every failure only leaves its source out: autoplay and the Daily Mix still
// have Deezer's radios.

import { fromApiTrack, type AutoplayTrack } from "./autoplay";

/** Similar tracks taken from each source, per seed. */
export const PER_SOURCE = 10;
const TIMEOUT_MS = 4000;
const DAY_MS = 24 * 60 * 60 * 1000;
/** MusicBrainz asks for at most one request per second per client. */
const MB_INTERVAL_MS = 1100;
const LB_ALGORITHM = "session_based_days_9000_session_300_contribution_5_threshold_15_limit_50_skip_30";
const USER_AGENT = `Wavelet/1.0 ( ${process.env.BETTER_AUTH_URL ?? "private music player"} )`;

export interface SimilarApi {
	getTrack(id: string): Promise<unknown>;
	search(query: string, options?: { limit?: number }): Promise<unknown>;
}

export interface NamedTrack {
	artist: string;
	title: string;
}

/** A small TTL cache (per server instance). */
export class TtlCache<V> {
	private map = new Map<string, { value: V; until: number }>();
	constructor(
		private ttlMs: number,
		private max = 5000
	) {}
	get(key: string, now = Date.now()): V | undefined {
		const hit = this.map.get(key);
		if (!hit) return undefined;
		if (hit.until < now) {
			this.map.delete(key);
			return undefined;
		}
		return hit.value;
	}
	set(key: string, value: V, now = Date.now()): void {
		if (this.map.size >= this.max) this.map.delete(this.map.keys().next().value as string);
		this.map.set(key, { value, until: now + this.ttlMs });
	}
	clear(): void {
		this.map.clear();
	}
}

const mbids = new TtlCache<string | null>(DAY_MS);
const lbSimilar = new TtlCache<NamedTrack[]>(DAY_MS);
const lfmSimilar = new TtlCache<NamedTrack[]>(DAY_MS);
const resolved = new TtlCache<AutoplayTrack | null>(DAY_MS);
const seedInfo = new TtlCache<{ artist: string; title: string; isrc: string | null } | null>(DAY_MS);

/** Empties every cache (tests). */
export function resetSimilarCaches(): void {
	for (const c of [mbids, lbSimilar, lfmSimilar, resolved, seedInfo]) c.clear();
	mbNext = 0;
}

let mbNext = 0;
/** Waits for this instance's next MusicBrainz slot. */
async function mbSlot(): Promise<void> {
	const now = Date.now();
	const at = Math.max(now, mbNext);
	mbNext = at + MB_INTERVAL_MS;
	if (at > now) await new Promise((r) => setTimeout(r, at - now));
}

async function getJson(url: string): Promise<unknown> {
	const res = await fetch(url, { headers: { "User-Agent": USER_AGENT, Accept: "application/json" }, signal: AbortSignal.timeout(TIMEOUT_MS) });
	if (!res.ok) throw new Error(`${new URL(url).host} answered ${res.status}`);
	return res.json();
}

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
export const normName = (s: string) =>
	s
		.toLowerCase()
		.normalize("NFKD")
		.replace(/[̀-ͯ]/g, "")
		.replace(/\s*[([].*?[)\]]\s*/g, " ")
		.replace(/[^a-z0-9]+/g, " ")
		.trim();

/** The MusicBrainz recording of an ISRC (null when MusicBrainz doesn't know it). */
export async function recordingMbid(isrc: string): Promise<string | null> {
	const hit = mbids.get(isrc);
	if (hit !== undefined) return hit;
	await mbSlot();
	const data = obj(await getJson(`https://musicbrainz.org/ws/2/isrc/${encodeURIComponent(isrc)}?fmt=json`));
	const mbid = str(obj(list(data.recordings)[0]).id);
	mbids.set(isrc, mbid);
	return mbid;
}

/** ListenBrainz: recordings listened to in the same sessions as `mbid`, best first. */
export async function listenBrainzSimilar(mbid: string): Promise<NamedTrack[]> {
	const hit = lbSimilar.get(mbid);
	if (hit) return hit;
	const rows = list(
		await getJson(
			`https://labs.api.listenbrainz.org/similar-recordings/json?recording_mbids=${encodeURIComponent(mbid)}&algorithm=${LB_ALGORITHM}`
		)
	);
	const out = rows
		.map(obj)
		.sort((a, b) => Number(b.score ?? 0) - Number(a.score ?? 0))
		.flatMap((r) => {
			const artist = str(r.artist_credit_name);
			const title = str(r.recording_name);
			return artist && title ? [{ artist, title }] : [];
		});
	lbSimilar.set(mbid, out);
	return out;
}

/** Last.fm: track.getSimilar (null without LASTFM_API_KEY). */
export async function lastFmSimilar(seed: NamedTrack, apiKey = process.env.LASTFM_API_KEY): Promise<NamedTrack[] | null> {
	if (!apiKey) return null;
	const key = `${normName(seed.artist)}\u0000${normName(seed.title)}`;
	const hit = lfmSimilar.get(key);
	if (hit) return hit;
	const params = new URLSearchParams({
		method: "track.getsimilar",
		artist: seed.artist,
		track: seed.title,
		autocorrect: "1",
		limit: "30",
		api_key: apiKey,
		format: "json",
	});
	const data = obj(await getJson(`https://ws.audioscrobbler.com/2.0/?${params}`));
	if (data.error) throw new Error(`Last.fm error ${String(data.error)}`);
	const out = list(obj(data.similartracks).track)
		.map(obj)
		.flatMap((t) => {
			const artist = str(obj(t.artist).name);
			const title = str(t.name);
			return artist && title ? [{ artist, title }] : [];
		});
	lfmSimilar.set(key, out);
	return out;
}

/**
 * The Deezer track for an artist + title: the first search result by that
 * artist with that title (a cover or a karaoke version by someone else is
 * not the same track). A plain search: Deezer's `artist:"…" track:"…"`
 * advanced search answered nothing at all (checked 2026-10-20).
 */
export async function resolveOnDeezer(api: SimilarApi, t: NamedTrack): Promise<AutoplayTrack | null> {
	const key = `${normName(t.artist)}\u0000${normName(t.title)}`;
	const hit = resolved.get(key);
	if (hit !== undefined) return hit;
	const res = obj(await api.search(`${t.artist} ${t.title}`, { limit: 5 }));
	const want = normName(t.artist);
	const title = normName(t.title);
	const close = (a: string, b: string) => a === b || (a.length > 0 && b.length > 0 && (a.includes(b) || b.includes(a)));
	const found =
		list(res.data)
			.map(fromApiTrack)
			.find((c) => {
				if (!c) return false;
				// The asked credit may name more artists ("Daft Punk feat. …"); a longer
				// Deezer name is someone else ("Justice Tribute Band").
				const got = normName(c.artist);
				return (got === want || want.startsWith(`${got} `)) && close(normName(c.title), title);
			}) ?? null;
	resolved.set(key, found);
	return found;
}

async function seedOf(api: SimilarApi, trackId: string) {
	const hit = seedInfo.get(trackId);
	if (hit !== undefined) return hit;
	const t = obj(await api.getTrack(trackId));
	const artist = str(obj(t.artist).name);
	const title = str(t.title);
	const info = artist && title ? { artist, title, isrc: str(t.isrc) } : null;
	seedInfo.set(trackId, info);
	return info;
}

async function resolveAll(api: SimilarApi, names: NamedTrack[]): Promise<AutoplayTrack[]> {
	const found = await Promise.all(names.slice(0, PER_SOURCE).map((n) => resolveOnDeezer(api, n).catch(() => null)));
	return found.filter((t): t is AutoplayTrack => t !== null);
}

const quiet = <T,>(label: string, p: Promise<T>, fallback: T): Promise<T> =>
	p.catch((e) => {
		console.warn(`[similar] ${label} failed:`, e instanceof Error ? e.message : String(e));
		return fallback;
	});

/**
 * Similar tracks to each seed, as Deezer tracks: one list per source and
 * seed (ListenBrainz then Last.fm, seed after seed), empty lists left out.
 */
export async function similarLists(api: SimilarApi, seedTrackIds: string[]): Promise<AutoplayTrack[][]> {
	const perSeed = await Promise.all(
		seedTrackIds.map(async (id) => {
			const seed = await quiet("seed lookup", seedOf(api, id), null);
			if (!seed) return [];
			const [lb, lfm] = await Promise.all([
				quiet(
					"ListenBrainz",
					(async () => {
						if (!seed.isrc) return [];
						const mbid = await recordingMbid(seed.isrc);
						return mbid ? resolveAll(api, await listenBrainzSimilar(mbid)) : [];
					})(),
					[] as AutoplayTrack[]
				),
				quiet(
					"Last.fm",
					lastFmSimilar(seed).then((names) => (names ? resolveAll(api, names) : [])),
					[] as AutoplayTrack[]
				),
			]);
			return [lb, lfm];
		})
	);
	return perSeed.flat().filter((l) => l.length > 0);
}
