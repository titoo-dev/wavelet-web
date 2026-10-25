/**
 * Pure helpers behind the Search screen: tabs, genre tiles, recent searches,
 * raw Deezer payload normalizers and the "Top result" pick. No React here, so
 * every branch is unit-tested in `search-model.test.ts`.
 */
import { rgbToOklch, type CoverSeed } from "@/lib/cover-palette";
import type { GwResults } from "@/lib/deezer/gw";

export type SearchTab = "all" | "track" | "album" | "artist" | "playlist";

export const TABS: { value: SearchTab; label: string }[] = [
	{ value: "all", label: "All" },
	{ value: "track", label: "Tracks" },
	{ value: "album", label: "Albums" },
	{ value: "artist", label: "Artists" },
	{ value: "playlist", label: "Playlists" },
];

export function parseTab(raw: string | null | undefined): SearchTab {
	return TABS.some((t) => t.value === raw) ? (raw as SearchTab) : "all";
}

// ─── Genres ────────────────────────────────────────────────────────────────

export type GenreGlyph = "star" | "mic" | "zap" | "wave" | "heart" | "martini" | "globe" | "coffee" | "piano" | "sun" | "sparkles" | "flame";

/** The mobile "Moods & genres" tiles: name, glyph and M3 seed colour. */
export const GENRES: { name: string; glyph: GenreGlyph; seed: string }[] = [
	{ name: "Pop", glyph: "star", seed: "#E91E63" },
	{ name: "Hip-Hop", glyph: "mic", seed: "#FF9800" },
	{ name: "Rock", glyph: "zap", seed: "#F44336" },
	{ name: "Electronic", glyph: "wave", seed: "#3F51B5" },
	{ name: "R&B", glyph: "heart", seed: "#9C27B0" },
	{ name: "Jazz", glyph: "martini", seed: "#795548" },
	{ name: "Afro", glyph: "globe", seed: "#4CAF50" },
	{ name: "Lo-fi", glyph: "coffee", seed: "#607D8B" },
	{ name: "Classical", glyph: "piano", seed: "#009688" },
	{ name: "Reggae", glyph: "sun", seed: "#CDDC39" },
	{ name: "K-Pop", glyph: "sparkles", seed: "#00BCD4" },
	{ name: "Metal", glyph: "flame", seed: "#424242" },
];

/** A hex seed colour → the `.cover-theme` seed (OKLCH hue + chroma factor). */
export function seedFromHex(hex: string): CoverSeed {
	const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
	if (!m) return { hue: 277, chroma: 1 };
	const n = parseInt(m[1], 16);
	const { c, h } = rgbToOklch((n >> 16) & 255, (n >> 8) & 255, n & 255);
	return { hue: Math.round(h), chroma: Math.round(Math.min(1, c / 0.09) * 100) / 100 };
}

/** A random genre name ("Surprise me"). */
export function randomGenre(random: () => number = Math.random): string {
	return GENRES[Math.min(GENRES.length - 1, Math.floor(random() * GENRES.length))].name;
}

// ─── Recent searches ───────────────────────────────────────────────────────

export const RECENT_MAX = 10;

/** Most recent first, case-insensitively de-duplicated, capped. */
export function pushRecent(list: readonly string[], term: string, max = RECENT_MAX): string[] {
	const t = term.trim();
	if (!t) return [...list];
	const lower = t.toLowerCase();
	return [t, ...list.filter((r) => r.toLowerCase() !== lower)].slice(0, max);
}

export function removeRecent(list: readonly string[], term: string): string[] {
	return list.filter((r) => r !== term);
}

/** Parse what was stored; anything malformed reads as empty. */
export function parseRecent(raw: string | null): string[] {
	if (!raw) return [];
	try {
		const v = JSON.parse(raw);
		return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim() !== "").slice(0, RECENT_MAX) : [];
	} catch {
		return [];
	}
}

// ─── Formatting ────────────────────────────────────────────────────────────

export function formatCompact(n: number): string {
	return new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(n);
}

export function plural(n: number, word: string): string {
	return `${n} ${word}${n === 1 ? "" : "s"}`;
}

// ─── Normalizers (GW `search/main` and public API `search` shapes) ─────────

function cdn(kind: string, hash: string | undefined, size: number): string | null {
	if (!hash) return null;
	if (hash.startsWith("http")) return hash;
	return `https://e-cdns-images.dzcdn.net/images/${kind}/${hash}/${size}x${size}-000000-80-0-0.jpg`;
}

export interface AlbumCard {
	id: string;
	title: string;
	artist: string | null;
	artistId: string | null;
	cover: string | null;
	year: string | null;
}

export function albumProps(a: GwResults): AlbumCard {
	const date: string | undefined = a.PHYSICAL_RELEASE_DATE || a.ORIGINAL_RELEASE_DATE || a.release_date;
	return {
		id: String(a.ALB_ID ?? a.id),
		title: a.ALB_TITLE || a.title || "",
		artist: a.ART_NAME || a.artist?.name || null,
		artistId: a.ART_ID != null ? String(a.ART_ID) : a.artist?.id != null ? String(a.artist.id) : null,
		cover: a.cover_xl || a.cover_big || a.cover_medium || cdn("cover", a.ALB_PICTURE, 500),
		year: date && /^\d{4}/.test(date) ? date.slice(0, 4) : null,
	};
}

export interface ArtistCard {
	id: string;
	name: string;
	picture: string | null;
	fans: number | null;
}

export function artistProps(a: GwResults): ArtistCard {
	const fans = a.NB_FAN ?? a.nb_fan;
	return {
		id: String(a.ART_ID ?? a.id),
		name: a.ART_NAME || a.name || "",
		picture: a.picture_xl || a.picture_big || a.picture_medium || cdn("artist", a.ART_PICTURE, 500),
		fans: typeof fans === "number" ? fans : fans != null && !Number.isNaN(Number(fans)) ? Number(fans) : null,
	};
}

export interface PlaylistCard {
	id: string;
	title: string;
	picture: string | null;
	nbTracks: number | null;
	creator: string | null;
}

export function playlistProps(p: GwResults): PlaylistCard {
	const n = p.NB_SONG ?? p.nb_tracks;
	return {
		id: String(p.PLAYLIST_ID ?? p.id),
		title: p.TITLE || p.title || "",
		picture: p.picture_xl || p.picture_big || p.picture_medium || cdn(p.PICTURE_TYPE || "playlist", p.PLAYLIST_PICTURE, 500),
		nbTracks: n == null ? null : Number(n),
		creator: p.PARENT_USERNAME || p.user?.name || null,
	};
}

export const albumSubtitle = (a: AlbumCard) => [a.artist, a.year].filter(Boolean).join(" · ") || undefined;
export const artistSubtitle = (a: ArtistCard) => (a.fans != null ? `${formatCompact(a.fans)} fans` : "Artist");
export const playlistSubtitle = (p: PlaylistCard) => (p.nbTracks != null ? plural(p.nbTracks, "track") : (p.creator ?? undefined));

/** A bigger Deezer track cover than the 56px one `trackFromDeezerRaw` keeps. */
export function trackCover(raw: GwResults, size = 500): string | null {
	return raw?.album?.cover_xl || raw?.album?.cover_big || cdn("cover", raw?.ALB_PICTURE, size);
}

// ─── search/main overview ──────────────────────────────────────────────────

export interface MainTotals {
	track: number | null;
	album: number | null;
	artist: number | null;
	playlist: number | null;
}

export function mainTotals(main: GwResults): MainTotals {
	const t = (k: string) => {
		const g = main?.[k];
		if (!g) return null;
		const n = g.total ?? g.count ?? g.data?.length;
		return typeof n === "number" ? n : null;
	};
	return { track: t("TRACK"), album: t("ALBUM"), artist: t("ARTIST"), playlist: t("PLAYLIST") };
}

export function isMainEmpty(main: GwResults): boolean {
	return !["TRACK", "ALBUM", "ARTIST", "PLAYLIST"].some((k) => (main?.[k]?.data?.length ?? 0) > 0);
}

export type TopPick = { kind: "artist"; raw: GwResults } | { kind: "track"; raw: GwResults } | { kind: "album"; raw: GwResults } | null;

/**
 * The hero "Top result": Deezer’s own pick when it is an artist, track or
 * album; else an artist whose name is the query, else the first track, else
 * the first album (the mobile rule).
 */
export function pickTopResult(main: GwResults, term: string): TopPick {
	const top = Array.isArray(main?.TOP_RESULT) ? main.TOP_RESULT[0] : null;
	const kind = top?.__TYPE__;
	if (kind === "artist" || kind === "track" || kind === "album") return { kind, raw: top };
	const artist = main?.ARTIST?.data?.[0];
	if (artist && artistProps(artist).name.trim().toLowerCase() === term.trim().toLowerCase()) return { kind: "artist", raw: artist };
	const track = main?.TRACK?.data?.[0];
	if (track) return { kind: "track", raw: track };
	const album = main?.ALBUM?.data?.[0];
	if (album) return { kind: "album", raw: album };
	return null;
}

/** Typed-search paging: is there another page after what we hold? */
export function hasMorePages(page: { data?: unknown[]; total?: number } | null | undefined): boolean {
	return !!page?.data && typeof page.total === "number" && page.data.length < page.total;
}
