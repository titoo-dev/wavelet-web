/** Lowercase, accents stripped, whitespace collapsed: "Beyoncé  " → "beyonce". */
export function foldText(s: string): string {
	return s
		.normalize("NFD")
		.replace(/[̀-ͯ]/g, "")
		.toLowerCase()
		.replace(/\s+/g, " ")
		.trim();
}

export interface FilterableTrack {
	title: string;
	artist: string;
	album?: string | null;
}

/**
 * The in-collection search (Spotify's "Find in playlist"): every word of the
 * query must appear in the track's title, artist or album, in any order,
 * ignoring case and accents. A blank query matches everything.
 */
export function trackMatcher(query: string): (track: FilterableTrack) => boolean {
	const words = foldText(query).split(" ").filter(Boolean);
	if (!words.length) return () => true;
	return (t) => {
		const hay = foldText(`${t.title} ${t.artist} ${t.album ?? ""}`);
		return words.every((w) => hay.includes(w));
	};
}
