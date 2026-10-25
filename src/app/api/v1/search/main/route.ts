import { NextRequest } from "next/server";
import { clean_search_query } from "@/lib/deezer/utils";
import { ok, fail, handleError, getGuestOrUserDz } from "../../_lib/helpers";

type Row = Record<string, unknown>;
/** A section of the gw pageSearch answer. */
type Section = { data?: Row[]; count?: number };
type PageSearch = { TRACK?: Section; ALBUM?: Section; ARTIST?: Section; [key: string]: unknown };
/** A public API search page. */
type ApiPage = { data?: Row[] } | null | undefined;

export async function GET(request: NextRequest) {
	try {
		const { dz } = await getGuestOrUserDz(request);
		if (!dz) return fail("NO_DEEZER", "Deezer is not available. Sign in or configure a service ARL.", 503);

		const rawTerm = request.nextUrl.searchParams.get("term") || "";
		const term = clean_search_query(rawTerm);
		if (!term) {
			return fail("MISSING_TERM", "Search term is required.", 400);
		}

		const [gwResults, apiTracks, apiAlbums, apiArtists] =
			await Promise.allSettled([
				dz.gw.search(term, 0, 100),
				dz.api.search_track(term, { limit: 50 }),
				dz.api.search_album(term, { limit: 50 }),
				dz.api.search_artist(term, { limit: 50 }),
			]);

		const gw: PageSearch =
			gwResults.status === "fulfilled" ? gwResults.value : {};
		const merged: PageSearch = { ...gw };

		if (apiTracks.status === "fulfilled") {
			const apiData = (apiTracks.value as ApiPage)?.data || [];
			const existingIds = new Set(
				(merged.TRACK?.data || []).map((t) => String(t.SNG_ID))
			);
			const newTracks = apiData.filter(
				(t) => !existingIds.has(String(t.id))
			);
			if (newTracks.length > 0) {
				merged.TRACK = merged.TRACK || { data: [], count: 0 };
				merged.TRACK.data = [...(merged.TRACK.data || []), ...newTracks];
				merged.TRACK.count = (merged.TRACK.count || 0) + newTracks.length;
			}
		}

		if (apiAlbums.status === "fulfilled") {
			const apiData = (apiAlbums.value as ApiPage)?.data || [];
			const existingIds = new Set(
				(merged.ALBUM?.data || []).map((a) => String(a.ALB_ID))
			);
			const newAlbums = apiData.filter(
				(a) => !existingIds.has(String(a.id))
			);
			if (newAlbums.length > 0) {
				merged.ALBUM = merged.ALBUM || { data: [], count: 0 };
				merged.ALBUM.data = [...(merged.ALBUM.data || []), ...newAlbums];
				merged.ALBUM.count = (merged.ALBUM.count || 0) + newAlbums.length;
			}
		}

		if (apiArtists.status === "fulfilled") {
			const apiData = (apiArtists.value as ApiPage)?.data || [];
			const existingIds = new Set(
				(merged.ARTIST?.data || []).map((a) => String(a.ART_ID))
			);
			const newArtists = apiData.filter(
				(a) => !existingIds.has(String(a.id))
			);
			if (newArtists.length > 0) {
				merged.ARTIST = merged.ARTIST || { data: [], count: 0 };
				merged.ARTIST.data = [
					...(merged.ARTIST.data || []),
					...newArtists,
				];
				merged.ARTIST.count =
					(merged.ARTIST.count || 0) + newArtists.length;
			}
		}

		return ok(merged);
	} catch (e) {
		return handleError(e);
	}
}
