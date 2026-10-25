import { NextRequest } from "next/server";
import { ok, fail, handleError, getGuestOrUserDz } from "../../_lib/helpers";
import { DeezerNetworkError, GWAPIError } from "@/lib/deezer/errors";

export async function GET(request: NextRequest) {
	try {
		const { dz } = await getGuestOrUserDz(request);
		if (!dz) return fail("NO_DEEZER", "Deezer is not available. Sign in or configure a service ARL.", 503);

		const searchParams = request.nextUrl.searchParams;
		const id = searchParams.get("id") || "";
		const type = searchParams.get("type") || "";

		if (!id || !type) {
			return fail("MISSING_PARAMS", "Both 'id' and 'type' parameters are required.", 400);
		}

		const validTypes = ["album", "playlist", "artist"];
		if (!validTypes.includes(type)) {
			return fail("INVALID_TYPE", `Type must be one of: ${validTypes.join(", ")}`, 400);
		}
		// Deezer ids are numeric; anything else (e.g. a Wavelet playlist cuid)
		// would be parsed as 0 by Deezer and fail as a 500.
		if (!/^\d+$/.test(id)) {
			return fail("INVALID_ID", "id must be a numeric Deezer id.", 400);
		}

		let data: Record<string, unknown>;

		switch (type) {
			case "album": {
				const albumPage = await dz.gw.get_album_page(id);
				const albumTracks = await dz.gw.get_album_tracks(id);
				data = { ...albumPage, tracks: albumTracks };
				break;
			}
			case "playlist": {
				const playlistPage = await dz.gw.get_playlist_page(id);
				const playlistTracks = await dz.gw.get_playlist_tracks(id);
				data = { ...playlistPage, tracks: playlistTracks };
				break;
			}
			case "artist": {
				const artistPage = await dz.gw.get_artist_page(id);
				const artistTop = await dz.gw.get_artist_top_tracks(id);
				const discography = await dz.gw.get_artist_discography_tabs(id, {
					limit: 100,
				});
				data = { ...artistPage, topTracks: artistTop, discography };
				break;
			}
		}

		return ok(data);
	} catch (e) {
		// Deezer refusing or not knowing the id is a client error, an unreachable
		// Deezer an upstream one — neither is our 500.
		if (e instanceof DeezerNetworkError) {
			return fail("UPSTREAM_ERROR", "Deezer is not reachable right now.", 502);
		}
		if (e instanceof GWAPIError && /DATA_ERROR|PERMISSION_ERROR|not allowed|not found/i.test(e.message)) {
			return fail("NOT_FOUND", "Not found on Deezer.", 404);
		}
		return handleError(e);
	}
}
