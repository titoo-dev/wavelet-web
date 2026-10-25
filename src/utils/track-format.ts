/** The fields of a gw or public API track the badge reads. */
type BadgeSource = Partial<
	Record<"FILESIZE_FLAC" | "FILESIZE_MP3_320" | "FILESIZE_MP3_256" | "FILESIZE_MP3_128", string | number>
> & { bitrate?: number | string; preview?: string };

/**
 * Compute the best available audio format label for a Deezer track.
 * GW API returns FILESIZE_FLAC, FILESIZE_MP3_320, etc. — non-zero means available.
 */
export function getBitrateBadge(track: BadgeSource | null | undefined): string {
	if (!track) return "—";
	if (Number(track.FILESIZE_FLAC) > 0) return "FLAC";
	if (Number(track.FILESIZE_MP3_320) > 0) return "320";
	if (Number(track.FILESIZE_MP3_256) > 0) return "256";
	if (Number(track.FILESIZE_MP3_128) > 0) return "128";
	// Standard API fallback
	if (track.bitrate) {
		const b = track.bitrate;
		if (b === 9 || b === "FLAC") return "FLAC";
		if (b === 3 || b === 320) return "320";
		if (b === 1 || b === 128) return "128";
	}
	if (track.preview) return "30s";
	return "—";
}

/**
 * Color class for the bitrate badge — accent for FLAC, muted card for others.
 */
export function getBitrateBadgeClass(label: string): string {
	if (label === "FLAC") return "bg-accent text-foreground border-foreground";
	return "bg-muted text-muted-foreground border-foreground";
}
