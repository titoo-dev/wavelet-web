import { NextRequest, NextResponse, after } from "next/server";
import { requireDeezerAndApp, handleError } from "../../_lib/helpers";
import { getPreferredBitrate } from "@/lib/wavelet/utils/getPreferredBitrate";
import { utils, type Deezer } from "@/lib/deezer";
import Track from "@/lib/wavelet/types/Track";
import { gwTrackCache, gwTrackKey } from "@/lib/wavelet/cache/deezer-track-cache";
import { findCachedCopy, loadStreamLicence } from "@/lib/wavelet/storage/cached-copy";

const { mapGwTrackToDeezer } = utils;

// GET /api/v1/stream-warm/[trackId]
// Prefetch / warm the Deezer metadata caches for a track. Issued by the
// client on hover/pointer-enter so that when the user actually clicks play,
// /api/v1/stream-progressive can skip its two Deezer round-trips
// (gw.get_track_with_fallback + media.deezer.com/v1/get_url).
//
// Crucially this does NOT open the encrypted audio stream and does NOT
// persist to storage — it only fills the in-memory metadata caches. So hovering
// over many tracks costs almost nothing.
export async function GET(
	request: NextRequest,
	{ params }: { params: Promise<{ trackId: string }> }
) {
	try {
		const auth = await requireDeezerAndApp(request);
		if (auth.error) return auth.error;
		const { dz, app, userId } = auth;
		const { trackId } = await params;
		const { maxBitrate } = await app.freshSettings();

		// A usable copy cached on storage (same rank rules as playback)?
		// Nothing to warm — playback uses the fast /stream path which doesn't
		// touch Deezer.
		const copy = await findCachedCopy(trackId, {
			maxBitrate: Number(maxBitrate),
			licence: await loadStreamLicence(userId),
		});
		if (copy.kind === "hit") return new NextResponse(null, { status: 204 });

		// Already warm for this Deezer account? Skip the work.
		if (gwTrackCache.get(gwTrackKey(dz.currentUser?.id, trackId))) {
			return new NextResponse(null, { status: 204 });
		}

		// Don't await any heavy / failure-prone work in the response path —
		// run it in after() so a slow Deezer doesn't slow the hover handler
		// and the function isn't frozen before the caches are filled.
		after(() => warmInBackground(dz, trackId, maxBitrate));

		return new NextResponse(null, { status: 204 });
	} catch (e) {
		return handleError(e);
	}
}

async function warmInBackground(
	dz: Deezer,
	trackId: string,
	preferredBitrate: number
) {
	try {
		const gwTrack = await dz.gw.get_track_with_fallback(trackId);
		gwTrackCache.set(gwTrackKey(dz.currentUser?.id, trackId), gwTrack);

		// Also warm the per-format URL cache. getPreferredBitrate is parallel
		// across formats and will fill trackUrlCache as a side effect.
		const apiTrack = mapGwTrackToDeezer(gwTrack);
		const track = new Track();
		track.parseEssentialData(apiTrack);
		if (track.local) return;
		await getPreferredBitrate(
			dz,
			track,
			Number(preferredBitrate),
			true,
			false,
			"",
			null
		).catch(() => {});
	} catch {
		// Best-effort; warming failures are silent.
	}
}
