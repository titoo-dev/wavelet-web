/**
 * Where an artist / album name links to. Every place that prints one of those
 * names goes through these helpers so the routes stay in one spot.
 *
 * Library rows (saved tracks, playlists, recent plays, saved albums, shares)
 * only store the artist *name*, so an artist without a Deezer id links to
 * `/artist?name=…` and the artist page resolves it through search (albums the
 * same way, by title + artist).
 */

type Id = string | number | null | undefined;

const present = (id: Id): id is string | number => id != null && String(id).trim() !== "" && String(id) !== "0";

export function artistHref(id: Id, name?: string | null): string | null {
	if (present(id)) return `/artist?id=${encodeURIComponent(String(id))}`;
	const n = name?.trim();
	return n ? `/artist?name=${encodeURIComponent(n)}` : null;
}

/** By id; rows that only kept the title link to `/album?title=…&artist=…`, resolved by the album page. */
export function albumHref(id: Id, title?: string | null, artist?: string | null): string | null {
	if (present(id)) return `/album?id=${encodeURIComponent(String(id))}`;
	const t = title?.trim();
	if (!t) return null;
	const a = artist?.trim();
	return `/album?title=${encodeURIComponent(t)}${a ? `&artist=${encodeURIComponent(primaryArtistName(a))}` : ""}`;
}

/** A track's song radio; null for ids the server can't build one from (user uploads are negative). */
export function trackRadioHref(trackId: Id): string | null {
	const id = trackId == null ? "" : String(trackId).trim();
	return /^[1-9]\d{0,19}$/.test(id) ? `/radio?track=${id}` : null;
}

/** "A, B", "A feat. B", "A ft B", "A (feat. B)" → "A". Ampersands stay ("Simon & Garfunkel"). */
export function primaryArtistName(name: string): string {
	const first = name.split(/\s*,\s*|\s+\(?(?:feat\.?|ft\.?|featuring)\s+/i)[0] ?? name;
	return first.trim() || name.trim();
}

const norm = (s: string) =>
	s
		.normalize("NFD")
		.replace(/[̀-ͯ]/g, "")
		.toLowerCase()
		.replace(/\s+/g, " ")
		.trim();

/** Drops a trailing "(…)" / "[…]" Deezer adds: "Nirvana (UK)", "Discovery (Remastered)". */
const base = (s: string) => norm(s).replace(/\s*[([].*$/, "") || norm(s);

/**
 * Picks the Deezer artist a printed name refers to: an exact (accent / case
 * insensitive) match on the full name, then on the primary artist, then the
 * same names without a "(…)" suffix. No match → null (the page says "not
 * found"); never Deezer's top result for another artist.
 */
export function pickArtistId(name: string, results: Array<{ id?: Id; name?: string | null }>): string | null {
	const candidates = results.filter((r) => present(r.id));
	const full = norm(name);
	const primary = norm(primaryArtistName(name));
	const hit =
		candidates.find((r) => norm(r.name ?? "") === full) ??
		candidates.find((r) => norm(r.name ?? "") === primary) ??
		candidates.find((r) => [full, primary].includes(base(r.name ?? "")));
	return hit ? String(hit.id) : null;
}

/**
 * Picks the Deezer album a printed title refers to: same title (accent / case
 * insensitive, then without an edition suffix) by the same artist. Without an
 * artist, the same title. No match → null; never another artist's album.
 */
export function pickAlbumId(title: string, artist: string | null | undefined, results: Array<{ id?: Id; title?: string | null; artist?: { name?: string | null } | null }>): string | null {
	const candidates = results.filter((r) => present(r.id));
	const t = norm(title);
	const a = artist ? norm(primaryArtistName(artist)) : null;
	const byArtist = (r: (typeof candidates)[number]) => a == null || norm(r.artist?.name ?? "") === a;
	const sameTitle = (r: (typeof candidates)[number]) => norm(r.title ?? "") === t;
	const sameBase = (r: (typeof candidates)[number]) => base(r.title ?? "") === base(title);
	const hit = candidates.find((r) => sameTitle(r) && byArtist(r)) ?? candidates.find((r) => sameBase(r) && byArtist(r));
	return hit ? String(hit.id) : null;
}
