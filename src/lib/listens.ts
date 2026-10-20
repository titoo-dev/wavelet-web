// The listening log (POST /api/v1/listens, ListenEvent): one entry per play,
// sent when the play ends. Shared by the route and the players.

/**
 * Why a play ended. completed: the track ran to its end (the queue moved on
 * by itself); skipped: the user moved to another track; stopped: playback
 * was cleared; failed: the track could not be played on; transferred: the
 * sound moved to another Device; closed: the page or app went away mid-track.
 */
export const LISTEN_END_REASONS = ["completed", "skipped", "stopped", "failed", "transferred", "closed"] as const;
export type ListenEndReason = (typeof LISTEN_END_REASONS)[number];

export const MAX_LISTENS_PER_REQUEST = 50;

export interface ListenInput {
	trackId: string;
	artistId?: string | null;
	albumId?: string | null;
	/** ISO 8601. */
	startedAt: string;
	/** ISO 8601; the server's clock when omitted. */
	endedAt?: string | null;
	/** Time actually listened to (seeks and pauses excluded). */
	msPlayed: number;
	durationMs?: number | null;
	endReason: ListenEndReason;
	/** "web", "android", "ios"… */
	client: string;
	shuffle?: boolean;
	/** How the track got into the queue: "autoplay", else not sent yet. */
	source?: string | null;
}
