import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser, ok, fail, handleError } from "../../_lib/helpers";
import { getPresignedUrl } from "@/lib/object-stream";
import { failStuckRenders, publicRender, type StoryRenderRow } from "@/lib/story/story-render";

/** The download link lasts an hour; ask again for a fresh one. */
const URL_TTL_SEC = 3600;

// GET /api/v1/stories/{renderId} — status and progress of one of your Story Renders, and once
// ready a presigned download URL (the MP4 is kept 24 h, then the status is "expired").
// Another user's render is a 404, as if it did not exist.
export async function GET(request: NextRequest, { params }: { params: Promise<{ renderId: string }> }) {
	try {
		const user = await requireUser(request);
		if (user.error) return user.error;
		const { renderId } = await params;

		const now = new Date();
		await failStuckRenders(now, user.userId);
		const row = (await prisma.storyRender.findFirst({ where: { id: renderId, userId: user.userId } })) as StoryRenderRow | null;
		if (!row) return fail("NOT_FOUND", "No such Lyrics Story.", 404);

		const shown = publicRender(row, now);
		if (shown.status !== "ready" || !row.storagePath) return ok(shown);
		const { url } = await getPresignedUrl(row.storagePath, URL_TTL_SEC);
		return ok({ ...publicRender(row, now, url), urlExpiresAt: new Date(now.getTime() + URL_TTL_SEC * 1000).toISOString() });
	} catch (e) {
		return handleError(e);
	}
}
