import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { ok, fail, handleError, requireUser } from "../../../_lib/helpers";
import { addToPlaylist, removeFromPlaylist, reorderPlaylist } from "@/lib/library";

/** One posted track, as the client sends it. */
interface PlaylistTrackInput {
	trackId: string | number;
	title?: string;
	artist?: string;
	album?: string | null;
	albumId?: string | null;
	coverUrl?: string | null;
	duration?: number | null;
}

// POST /api/v1/playlists/[id]/tracks — add track(s) to playlist
export async function POST(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
	try {
		const { userId, error } = await requireUser(request);
		if (error) return error;

		const { id } = await ctx.params;
		const playlist = await prisma.playlist.findFirst({ where: { id, userId } });
		if (!playlist) return fail("NOT_FOUND", "Playlist not found.", 404);

		const { tracks } = await request.json();
		if (!Array.isArray(tracks) || tracks.length === 0) {
			return fail("MISSING_TRACKS", "tracks array is required.", 400);
		}

		const result = await addToPlaylist(
			id,
			tracks.map((t: PlaylistTrackInput) => ({
				trackId: String(t.trackId),
				title: String(t.title || ""),
				artist: String(t.artist || ""),
				album: t.album ?? null,
				albumId: t.albumId ?? null,
				coverUrl: t.coverUrl ?? null,
				duration: t.duration ?? null,
			}))
		);
		return ok(result);
	} catch (e) {
		return handleError(e);
	}
}

// PATCH /api/v1/playlists/[id]/tracks — reorder tracks in a playlist.
// Body shape: { trackIds: string[] } — the new order, must include exactly
// the trackIds already in the playlist (no more, no less, no duplicates).
// Positions are rewritten 0..N-1 in a single transaction.
export async function PATCH(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
	try {
		const { userId, error } = await requireUser(request);
		if (error) return error;

		const { id } = await ctx.params;
		const playlist = await prisma.playlist.findFirst({ where: { id, userId } });
		if (!playlist) return fail("NOT_FOUND", "Playlist not found.", 404);

		const { trackIds } = await request.json();
		if (!Array.isArray(trackIds)) {
			return fail("MISSING_TRACK_IDS", "trackIds array is required.", 400);
		}

		try {
			const result = await reorderPlaylist(id, trackIds.map(String));
			return ok(result);
		} catch (e) {
			const code = e instanceof Error ? e.message : "REORDER_FAILED";
			if (code === "REORDER_LENGTH_MISMATCH") {
				return fail(code, "trackIds length must match the playlist's track count.", 400);
			}
			if (code === "REORDER_DUPLICATE_TRACK") {
				return fail(code, "trackIds contains duplicate entries.", 400);
			}
			if (code === "REORDER_UNKNOWN_TRACK") {
				return fail(code, "trackIds contains a track not in this playlist.", 400);
			}
			throw e;
		}
	} catch (e) {
		return handleError(e);
	}
}

// DELETE /api/v1/playlists/[id]/tracks — unlink tracks from a playlist.
// Pure metadata operation: playlists don't anchor file lifecycle in the new
// model, so removing a track from a playlist never touches storage.
export async function DELETE(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
	try {
		const { userId, error } = await requireUser(request);
		if (error) return error;

		const { id } = await ctx.params;
		const playlist = await prisma.playlist.findFirst({ where: { id, userId } });
		if (!playlist) return fail("NOT_FOUND", "Playlist not found.", 404);

		const { trackIds } = await request.json();
		if (!Array.isArray(trackIds) || trackIds.length === 0) {
			return fail("MISSING_TRACK_IDS", "trackIds array is required.", 400);
		}

		const result = await removeFromPlaylist(id, trackIds.map(String));
		return ok(result);
	} catch (e) {
		return handleError(e);
	}
}
