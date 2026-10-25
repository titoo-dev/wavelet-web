import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { describeErrorForLog } from "@/lib/log-safe";
import { fromApiTrack, pickAutoplay, signalsFrom, type AutoplayTrack } from "@/lib/autoplay";
import { similarLists } from "@/lib/similar";
import { requireUser, getGuestOrUserDz, ok, fail, handleError } from "../../../_lib/helpers";

const TRACK_ID = /^\d{1,20}$/;
const RADIO_SIZE = 50;
const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 50;
/** How far back the listening log is read. */
const SIGNALS_WINDOW_MS = 60 * 24 * 60 * 60 * 1000;

const apiTracks = (v: unknown): AutoplayTrack[] => {
	const data = (v as { data?: unknown[] } | null)?.data;
	return Array.isArray(data) ? data.map(fromApiTrack).filter((t): t is AutoplayTrack => t !== null) : [];
};

// GET /api/v1/tracks/[trackId]/radio[?limit=30] — the track's radio: songs
// that sound like it. ListenBrainz / Last.fm tracks similar to this one lead,
// Deezer's radio of its artist fills in; the same taste filters as autoplay
// (early skips, skipped artists, played in the last hours), at most 2 per
// artist. `seed` is the track itself, as Deezer knows it.
export async function GET(request: NextRequest, { params }: { params: Promise<{ trackId: string }> }) {
	try {
		const userResult = await requireUser(request);
		if (userResult.error) return userResult.error;
		const userId = userResult.userId;

		const { trackId } = await params;
		if (!TRACK_ID.test(trackId)) return fail("INVALID_TRACK_ID", "trackId must be a Deezer track id.", 400);
		const asked = request.nextUrl.searchParams.get("limit");
		const limit = asked === null ? DEFAULT_LIMIT : Number(asked);
		if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
			return fail("INVALID_LIMIT", `limit must be an integer from 1 to ${MAX_LIMIT}.`, 400);
		}

		const { dz } = await getGuestOrUserDz(request);
		if (!dz) return fail("NO_DEEZER", "Deezer is not available. Sign in or configure a service ARL.", 503);

		const seed = await dz.api.getTrack(trackId).then(fromApiTrack, () => null);
		if (!seed) return fail("NOT_FOUND", "This track is not known to Deezer.", 404);

		const now = Date.now();
		const [radio, similar, listens] = await Promise.all([
			seed.artistId
				? dz.api.get_artist_radio(seed.artistId, { limit: RADIO_SIZE }).then(apiTracks, (e: unknown) => {
						console.warn("[track-radio] artist radio failed:", describeErrorForLog(e));
						return [];
					})
				: Promise.resolve([] as AutoplayTrack[]),
			similarLists(dz.api, [trackId]),
			prisma.listenEvent.findMany({
				where: { userId, startedAt: { gte: new Date(now - SIGNALS_WINDOW_MS) } },
				select: { trackId: true, artistId: true, endReason: true, msPlayed: true, startedAt: true },
				orderBy: { startedAt: "desc" },
				take: 5000,
			}),
		]);
		const lists = [...similar, radio].filter((l) => l.length > 0);
		if (lists.length === 0) return fail("UPSTREAM_ERROR", "Deezer is not reachable right now.", 502);

		const tracks = pickAutoplay(lists, {
			exclude: new Set([trackId]),
			signals: signalsFrom(listens, now),
			limit,
		});
		return ok({ seed, tracks });
	} catch (e) {
		return handleError(e);
	}
}
