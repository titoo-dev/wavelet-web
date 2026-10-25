import { after, NextRequest } from "next/server";
import { requireUser, readJsonBody, ok, fail, handleError } from "../_lib/helpers";
import { MAX_SHARE_TEXT, safeCoverUrl } from "@/lib/share-meta";
import { parseLyricsRange } from "@/lib/story/range";
import { isStoryTheme, STORY_THEMES } from "@/lib/story/themes";
import { DAILY_RENDER_LIMIT, publicRender, requestRender, runRender } from "@/lib/story/story-render";

export const runtime = "nodejs";
// The render runs in after() within this budget (docs/adr/0004: ~41 s for 30 s of 1080p on 2 vCPU, so ~85 s for the 60 s maximum).
export const maxDuration = 300;

const text = (v: unknown) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, MAX_SHARE_TEXT) : "");

// POST /api/v1/stories — ask for a Story Render of a Lyrics Range in a Story Theme (CONTEXT.md).
// 202 with the new render (it runs after the response), 200 with the same request's live render,
// 409 RENDER_IN_PROGRESS while another one runs, 429 DAILY_LIMIT after 20 in 24 h.
export async function POST(request: NextRequest) {
	try {
		const user = await requireUser(request);
		if (user.error) return user.error;

		const { body, error } = await readJsonBody(request);
		if (error) return error;

		const trackId = typeof body.trackId === "string" || typeof body.trackId === "number" ? String(body.trackId) : "";
		if (!/^\d+$/.test(trackId)) return fail("MISSING_TRACK_ID", "trackId must be a Deezer track id.", 400);
		if (!isStoryTheme(body.theme)) {
			return fail("INVALID_THEME", `theme must be one of ${STORY_THEMES.join(", ")}.`, 400);
		}
		const title = text(body.title);
		const artist = text(body.artist);
		if (!title || !artist) return fail("MISSING_METADATA", "title and artist are required.", 400);
		const parsed = parseLyricsRange(body);
		if (!parsed.ok) return fail("INVALID_RANGE", parsed.message, 400);

		const now = new Date();
		const result = await requestRender(
			user.userId,
			{
				trackId,
				theme: body.theme,
				title,
				artist,
				coverUrl: safeCoverUrl(body.coverUrl),
				trackDurationMs: Math.round(body.trackDurationMs as number),
				nextLineMs: typeof body.nextLineMs === "number" ? Math.round(body.nextLineMs) : null,
				range: parsed.range,
			},
			now
		);
		switch (result.kind) {
			case "reused":
				return ok(publicRender(result.render, now));
			case "busy": {
				const res = fail("RENDER_IN_PROGRESS", "Another Lyrics Story is being rendered; wait for it to finish.", 409);
				return withRenderId(res, result.render.id);
			}
			case "limit":
				return fail("DAILY_LIMIT", `At most ${DAILY_RENDER_LIMIT} Lyrics Stories a day.`, 429);
			case "created":
				after(() => runRender(result.render.id));
				return ok(publicRender(result.render, now), 202);
		}
	} catch (e) {
		return handleError(e);
	}
}

/** The running render's id, so the client can follow it instead. */
function withRenderId(res: Response, id: string) {
	res.headers.set("X-Story-Render-Id", id);
	return res;
}
