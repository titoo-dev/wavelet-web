import { NextRequest } from "next/server";
import { timingSafeEqual } from "crypto";
import { ok, fail } from "../../_lib/helpers";
import { collectStorageGarbage } from "@/lib/wavelet/storage/gc";
import { createStorageProvider } from "@/lib/wavelet/storage/factory";
import { collectStoryGarbage } from "@/lib/story/story-render";

export const maxDuration = 60;

function authorized(header: string | null, secret: string): boolean {
	const expected = Buffer.from(`Bearer ${secret}`);
	const given = Buffer.from(header ?? "");
	return given.length === expected.length && timingSafeEqual(given, expected);
}

// GET /api/v1/internal/gc — daily storage garbage collection (vercel.json
// cron). Requires "Authorization: Bearer ${CRON_SECRET}" (Vercel sends it to
// cron invocations when CRON_SECRET is set); 401 otherwise. A no-op while
// CRON_SECRET is unset. See src/lib/wavelet/storage/gc.ts for what it deletes.
export async function GET(request: NextRequest) {
	const secret = process.env.CRON_SECRET;
	if (!secret) return ok({ ran: false, reason: "CRON_SECRET is not configured" });
	if (!authorized(request.headers.get("authorization"), secret)) {
		return fail("UNAUTHORIZED", "Missing or invalid cron secret.", 401);
	}
	try {
		const storage = createStorageProvider();
		const report = await collectStorageGarbage({ deleteObject: (key) => storage.deleteFile(key) });
		// Lyrics Stories: MP4s past 24 h, rows past 7 days, renders that died with their function.
		const stories = await collectStoryGarbage((key) => storage.deleteFile(key));
		return ok({ ran: true, ...report, stories });
	} catch (e) {
		console.error("[internal/gc] failed:", e);
		return fail("INTERNAL_ERROR", "Garbage collection failed.", 500);
	}
}
