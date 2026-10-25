import { NextRequest } from "next/server";
import { requireUser, readJsonBody, fail, handleError } from "../../_lib/helpers";
import { createRateLimiter } from "@/lib/wavelet/cache/rate-limit";
import { MAX_SHARE_TEXT } from "@/lib/share-meta";
import { parseLyricsRange } from "@/lib/story/range";
import { isStoryTheme, STORY_THEMES } from "@/lib/story/themes";
import { loadCover, renderStill } from "@/lib/story/still";

export const runtime = "nodejs";

/** Theme Stills are cheap but not free: 60 a minute per user and server instance. */
const limiter = createRateLimiter({ limit: 60, windowMs: 60_000 });

/** For tests. */
export function resetStillLimiter() {
	limiter.reset();
}

const text = (v: unknown) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, MAX_SHARE_TEXT) : "");

// POST /api/v1/stories/stills — the Theme Still (JPEG) of a Lyrics Range in one Story Theme.
// The lines come from the client (docs/adr/0005); the cover only from Deezer's CDN.
export async function POST(request: NextRequest) {
	try {
		const user = await requireUser(request);
		if (user.error) return user.error;

		const { body, error } = await readJsonBody(request);
		if (error) return error;

		if (!isStoryTheme(body.theme)) {
			return fail("INVALID_THEME", `theme must be one of ${STORY_THEMES.join(", ")}.`, 400);
		}
		const title = text(body.title);
		const artist = text(body.artist);
		if (!title || !artist) return fail("MISSING_METADATA", "title and artist are required.", 400);
		const parsed = parseLyricsRange(body);
		if (!parsed.ok) return fail("INVALID_RANGE", parsed.message, 400);

		const hit = limiter.take(user.userId);
		if (!hit.ok) {
			const res = fail("RATE_LIMITED", "Too many Theme Stills; try again shortly.", 429);
			res.headers.set("Retry-After", String(hit.retryAfterSec));
			return res;
		}

		const cover = await loadCover(body.coverUrl as string | undefined);
		const jpeg = await renderStill({ range: parsed.range, theme: body.theme, title, artist, cover });
		return new Response(new Uint8Array(jpeg), {
			headers: {
				"Content-Type": "image/jpeg",
				"Content-Length": String(jpeg.length),
				"Cache-Control": "private, max-age=3600",
			},
		});
	} catch (e) {
		return handleError(e);
	}
}
