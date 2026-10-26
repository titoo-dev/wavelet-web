/**
 * Parsers for the `content/tracklist` payloads behind the album, artist and
 * Deezer-playlist pages (the Flutter `AlbumPage` / `ArtistPage` /
 * `DeezerPlaylistPage` models). Deezer's GW responses are loosely typed, so
 * every field is probed defensively and missing data simply drops out.
 */

import { deezerImage } from "@/lib/discover";

type Json = Record<string, unknown>;

const obj = (v: unknown): Json => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {});
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : typeof v === "number" ? String(v) : null);
const num = (v: unknown): number | null => {
	const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
	return Number.isFinite(n) ? n : null;
};

// ─── Formatting ─────────────────────────────────────────────────────────────

/** `1 track` / `12 tracks`. */
export function plural(n: number, word: string): string {
	return `${n.toLocaleString("en")} ${word}${n === 1 ? "" : "s"}`;
}

/** Compact count: 1.2M, 249.6K, 812. */
export function compactNumber(n: number): string {
	return new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(n);
}

/** Total running time: `42 min`, `1 hr 3 min`, `2 hr`. */
export function formatTotal(seconds: number): string {
	const min = Math.round(seconds / 60);
	if (min < 60) return `${Math.max(min, 1)} min`;
	const hr = Math.floor(min / 60);
	const rest = min % 60;
	return rest ? `${hr} hr ${rest} min` : `${hr} hr`;
}

/** `2026-04-10` → `April 10, 2026` (unparseable input is returned as is). */
export function formatReleaseDate(date: string): string {
	const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(date);
	if (!m) return date;
	const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
	if (Number.isNaN(d.getTime())) return date;
	return d.toLocaleDateString("en", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** Deezer bios are HTML: keep paragraph breaks, drop tags, decode entities. */
export function htmlToText(html: string): string {
	return html
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/<\/p>\s*<p[^>]*>/gi, "\n\n")
		.replace(/<[^>]+>/g, "")
		.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (all, code: string) => {
			if (code[0] === "#") {
				const n = code[1].toLowerCase() === "x" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
				return Number.isFinite(n) ? String.fromCodePoint(n) : all;
			}
			return ENTITIES[code.toLowerCase()] ?? all;
		})
		.replace(/[ \t]+\n/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

// ─── Release types ──────────────────────────────────────────────────────────

export type RecordType = "Album" | "Single" | "EP" | "Compilation";

/** GW `TYPE` (0 single, 1 album, 2 compilation, 3 EP) or API `record_type`. */
export function recordTypeLabel(type: unknown): RecordType | null {
	const v = str(type)?.toLowerCase();
	switch (v) {
		case "0":
		case "single":
			return "Single";
		case "1":
		case "album":
			return "Album";
		case "2":
		case "compile":
		case "compilation":
			return "Compilation";
		case "3":
		case "ep":
			return "EP";
		default:
			return null;
	}
}

export interface ReleaseCard {
	id: string;
	title: string;
	cover: string | null;
	year: string | null;
	recordType: RecordType | null;
	trackCount: number | null;
}

/** Any raw album (GW `ALB_*` or public API) → card data. */
export function releaseFromRaw(raw: unknown): ReleaseCard | null {
	const a = obj(raw);
	const id = str(a.ALB_ID ?? a.id);
	if (!id) return null;
	const date = str(a.release_date ?? a.ORIGINAL_RELEASE_DATE ?? a.PHYSICAL_RELEASE_DATE ?? a.DIGITAL_RELEASE_DATE);
	return {
		id,
		title: str(a.ALB_TITLE ?? a.title) ?? "Untitled",
		cover: str(a.cover_big ?? a.cover_medium ?? a.cover_xl) ?? deezerImage(str(a.ALB_PICTURE ?? a.md5_image)),
		year: date && /^\d{4}/.test(date) && !date.startsWith("0000") ? date.slice(0, 4) : null,
		recordType: recordTypeLabel(a.TYPE ?? a.record_type),
		trackCount: num(a.nb_tracks ?? a.NUMBER_TRACK),
	};
}

// ─── Album ──────────────────────────────────────────────────────────────────

export interface AlbumPageData {
	id: string;
	title: string;
	artist: string | null;
	artistId: string | null;
	artistPicture: string | null;
	cover: string | null;
	recordType: RecordType;
	year: string | null;
	releaseDate: string | null;
	label: string | null;
	copyright: string | null;
	/** Total seconds (from the album, else summed from the tracks). */
	duration: number | null;
	/** Raw tracks, in order (normalize with `trackFromDeezerRaw`). */
	tracks: unknown[];
	/** Disc number per track (same order as `tracks`). */
	discs: number[];
	discCount: number;
	/** Other releases by the main artist (the album itself excluded). */
	moreByArtist: ReleaseCard[];
}

export function parseAlbumPage(data: unknown, fallbackId = ""): AlbumPageData | null {
	const root = obj(data);
	const d = obj(root.DATA ?? root);
	const id = str(d.ALB_ID ?? d.id) ?? fallbackId;
	const title = str(d.ALB_TITLE ?? d.title);
	if (!title) return null;

	const tracks = list(root.tracks).length ? list(root.tracks) : list(obj(root.SONGS).data);
	const discs = tracks.map((t) => num(obj(t).DISK_NUMBER ?? obj(t).disk_number) ?? 1);
	const discCount = new Set(discs).size;

	const mainArtist = obj(list(d.ARTISTS)[0]);
	const artistObj = obj(d.artist);
	const others = list(obj(root.ALBUMS).data);
	const self = others.find((a) => str(obj(a).ALB_ID) === id);
	const date = str(d.ORIGINAL_RELEASE_DATE ?? d.PHYSICAL_RELEASE_DATE ?? d.DIGITAL_RELEASE_DATE ?? d.release_date);
	const sum = tracks.reduce<number>((s, t) => s + (num(obj(t).DURATION ?? obj(t).duration) ?? 0), 0);

	const seen = new Set<string>([id]);
	const moreByArtist: ReleaseCard[] = [];
	for (const raw of others) {
		const card = releaseFromRaw(raw);
		if (!card || seen.has(card.id)) continue;
		seen.add(card.id);
		moreByArtist.push(card);
	}

	return {
		id,
		title,
		artist: str(d.ART_NAME ?? artistObj.name),
		artistId: str(d.ART_ID ?? artistObj.id),
		artistPicture: str(artistObj.picture_medium) ?? deezerImage(str(mainArtist.ART_PICTURE), "artist", 250),
		cover: str(d.cover_xl ?? d.cover_big) ?? deezerImage(str(d.ALB_PICTURE)),
		recordType: recordTypeLabel(d.TYPE ?? d.record_type) ?? recordTypeLabel(obj(self).TYPE) ?? (obj(d.SUBTYPES).isCompilation === true ? "Compilation" : "Album"),
		year: date && /^\d{4}/.test(date) && !date.startsWith("0000") ? date.slice(0, 4) : null,
		releaseDate: date && !date.startsWith("0000") ? date : null,
		label: str(d.LABEL_NAME ?? d.label),
		copyright: str(d.COPYRIGHT ?? d.PRODUCER_LINE),
		duration: num(d.DURATION ?? d.duration) || sum || null,
		tracks,
		discs,
		discCount,
		moreByArtist,
	};
}

export type AlbumRow = { kind: "disc"; disc: number } | { kind: "track"; index: number };

/** Tracks interleaved with "Disc N" headers when the album spans discs. */
export function albumRows(discs: number[], keep: (index: number) => boolean = () => true): AlbumRow[] {
	const multi = new Set(discs).size > 1;
	const rows: AlbumRow[] = [];
	let last: number | null = null;
	discs.forEach((disc, i) => {
		if (!keep(i)) return;
		// A disc keeps its header only while one of its tracks is shown.
		if (multi && disc !== last) rows.push({ kind: "disc", disc });
		last = disc;
		rows.push({ kind: "track", index: i });
	});
	return rows;
}

// ─── Artist ─────────────────────────────────────────────────────────────────

export interface RelatedArtist {
	id: string;
	name: string;
	picture: string | null;
	fans: number | null;
}

export interface ArtistPageData {
	id: string;
	name: string;
	picture: string | null;
	fans: number | null;
	bio: string | null;
	topTracks: unknown[];
	/** Release tabs with content, in display order. */
	tabs: { key: string; label: string; releases: ReleaseCard[] }[];
	albumCount: number | null;
	related: RelatedArtist[];
	/** Distinct discography covers (hero artwork wall). */
	covers: string[];
}

const TAB_ORDER = ["all", "album", "single", "ep", "featured", "more"];
export const RELEASE_TAB_LABELS: Record<string, string> = {
	all: "All",
	album: "Albums",
	single: "Singles",
	ep: "EPs",
	featured: "Featured",
	more: "More",
};

export function parseArtistPage(data: unknown, fallbackId = ""): ArtistPageData | null {
	const root = obj(data);
	const d = obj(root.DATA ?? root);
	const name = str(d.ART_NAME ?? d.name);
	if (!name) return null;

	const bioRoot = root.BIO ?? d.BIO;
	const bioRaw = str(obj(bioRoot).BIO) ?? str(bioRoot) ?? str(obj(bioRoot).RESUME) ?? str(d.bio) ?? str(d.description);
	const bio = bioRaw ? htmlToText(bioRaw) || null : null;

	const disco = obj(root.discography);
	const keys = [...TAB_ORDER, ...Object.keys(disco).filter((k) => !TAB_ORDER.includes(k))];
	const tabs = keys
		.map((key) => ({
			key,
			label: RELEASE_TAB_LABELS[key] ?? key.charAt(0).toUpperCase() + key.slice(1),
			releases: list(disco[key])
				.map(releaseFromRaw)
				.filter((r): r is ReleaseCard => r !== null),
		}))
		.filter((t) => t.releases.length > 0);

	const covers = [...new Set(tabs.flatMap((t) => t.releases.map((r) => r.cover)).filter((c): c is string => !!c))].slice(0, 40);

	const related: RelatedArtist[] = [];
	for (const raw of list(obj(root.RELATED_ARTISTS).data)) {
		const a = obj(raw);
		const id = str(a.ART_ID ?? a.id);
		const rName = str(a.ART_NAME ?? a.name);
		if (!id || !rName) continue;
		related.push({
			id,
			name: rName,
			picture: str(a.picture_medium) ?? deezerImage(str(a.ART_PICTURE), "artist", 250),
			fans: num(a.NB_FAN ?? a.nb_fan),
		});
	}

	const topTracks = list(root.topTracks).length ? list(root.topTracks) : list(obj(root.TOP).data);
	const albumTab = tabs.find((t) => t.key === "album");

	return {
		id: str(d.ART_ID ?? d.id) ?? fallbackId,
		name,
		picture: str(d.picture_xl ?? d.picture_big) ?? deezerImage(str(d.ART_PICTURE), "artist"),
		fans: num(d.NB_FAN ?? d.nb_fan),
		bio,
		topTracks,
		tabs,
		albumCount: albumTab ? albumTab.releases.length : null,
		related,
		covers,
	};
}

// ─── Deezer playlist ────────────────────────────────────────────────────────

export interface PlaylistPageData {
	id: string;
	title: string;
	creator: string | null;
	description: string | null;
	cover: string | null;
	fans: number | null;
	duration: number | null;
	tracks: unknown[];
}

export function parsePlaylistPage(data: unknown, fallbackId = ""): PlaylistPageData | null {
	const root = obj(data);
	const d = obj(root.DATA ?? root);
	const title = str(d.TITLE ?? d.title);
	if (!title) return null;
	const tracks = list(root.tracks).length ? list(root.tracks) : list(obj(root.SONGS).data);
	const sum = tracks.reduce<number>((s, t) => s + (num(obj(t).DURATION ?? obj(t).duration) ?? 0), 0);
	const description = str(d.DESCRIPTION ?? d.description);
	return {
		id: str(d.PLAYLIST_ID ?? d.id) ?? fallbackId,
		title,
		creator: str(d.PARENT_USERNAME ?? obj(d.creator).name),
		description: description ? htmlToText(description) || null : null,
		cover: str(d.picture_xl ?? d.picture_big) ?? deezerImage(str(d.PLAYLIST_PICTURE), str(d.PICTURE_TYPE) ?? "playlist"),
		fans: num(d.NB_FAN ?? d.fans),
		duration: num(d.DURATION ?? d.duration) || sum || null,
		tracks,
	};
}

/** Distinct track covers (≥ 8 lights up the hero artwork wall). */
export function trackCovers(covers: (string | null | undefined)[], max = 40): string[] {
	return [...new Set(covers.filter((c): c is string => !!c))].slice(0, max);
}
