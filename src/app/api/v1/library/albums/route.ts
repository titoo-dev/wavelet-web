import { NextRequest } from "next/server";
import { requireUser, ok, fail, handleError } from "../../_lib/helpers";
import { saveAlbum, listSavedAlbums } from "@/lib/library";

// GET /api/v1/library/albums — list user's saved albums
export async function GET(request: NextRequest) {
	try {
		const userResult = await requireUser(request);
		if (userResult.error) return userResult.error;

		const items = await listSavedAlbums(userResult.userId);
		return ok({ items });
	} catch (e) {
		return handleError(e);
	}
}

/** One track of the posted tracklist, as the client sends it. */
interface AlbumTrackInput {
	trackId: string | number;
	title?: string;
	artist?: string;
	coverUrl?: string | null;
	duration?: number | string | null;
	trackNumber?: number | string | null;
}

// POST /api/v1/library/albums — save an album (with its tracklist)
export async function POST(request: NextRequest) {
	try {
		const userResult = await requireUser(request);
		if (userResult.error) return userResult.error;

		const body = await request.json().catch(() => null);
		if (
			!body ||
			typeof body.deezerAlbumId !== "string" ||
			!body.deezerAlbumId ||
			typeof body.title !== "string" ||
			typeof body.artist !== "string" ||
			!Array.isArray(body.tracks)
		) {
			return fail(
				"INVALID_BODY",
				"deezerAlbumId, title, artist, tracks[] are required.",
				400
			);
		}

		try {
			const saved = await saveAlbum(
				userResult.userId,
				{
					deezerAlbumId: body.deezerAlbumId,
					title: body.title,
					artist: body.artist,
					coverUrl: body.coverUrl ?? null,
				},
				body.tracks.map((t: AlbumTrackInput) => ({
					trackId: String(t.trackId),
					title: String(t.title || ""),
					artist: String(t.artist || ""),
					coverUrl: t.coverUrl ?? null,
					duration: t.duration != null ? Number(t.duration) : null,
					trackNumber: t.trackNumber != null ? Number(t.trackNumber) : null,
				}))
			);
			return ok({ saved });
		} catch (e) {
			console.error("[POST /library/albums] saveAlbum failed:", e);
			throw e;
		}
	} catch (e) {
		return handleError(e);
	}
}
