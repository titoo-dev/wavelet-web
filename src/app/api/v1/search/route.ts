import { NextRequest } from "next/server";
import { clean_search_query } from "@/lib/deezer/utils";
import { ok, fail, handleError, getGuestOrUserDz } from "../_lib/helpers";
import type { API } from "@/lib/deezer";

const searchMethods: Record<string, "search_track" | "search_album" | "search_artist" | "search_playlist"> = {
	track: "search_track",
	album: "search_album",
	artist: "search_artist",
	playlist: "search_playlist",
};

export async function GET(request: NextRequest) {
	try {
		const { dz } = await getGuestOrUserDz(request);
		if (!dz) return fail("NO_DEEZER", "Deezer is not available. Sign in or configure a service ARL.", 503);

		const searchParams = request.nextUrl.searchParams;
		const rawTerm = searchParams.get("term") || "";
		const type = searchParams.get("type") || "track";
		const start = parseInt(searchParams.get("start") || "0", 10);
		const nb = parseInt(searchParams.get("nb") || "100", 10);

		const term = clean_search_query(rawTerm);
		if (!term) {
			return fail("MISSING_TERM", "Search term is required.", 400);
		}

		const method = searchMethods[type];
		if (!method) {
			return fail("INVALID_TYPE", `Type must be one of: ${Object.keys(searchMethods).join(", ")}`, 400);
		}

		const results = await (dz.api as API)[method](term, {
			index: start,
			limit: nb,
		});

		return ok(results);
	} catch (e) {
		return handleError(e);
	}
}
