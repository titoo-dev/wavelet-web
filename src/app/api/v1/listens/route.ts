import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { LISTEN_END_REASONS, MAX_LISTENS_PER_REQUEST } from "@/lib/listens";
import { requireUser, ok, fail, handleError } from "../_lib/helpers";

// A client may hold listens while offline: older ones are dropped, not stored.
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
// Clock skew tolerated between a client and the server.
const FUTURE_SKEW_MS = 5 * 60 * 1000;
const MAX_PLAYED_MS = 24 * 60 * 60 * 1000;

const id = z.string().trim().min(1).max(64);

const listenSchema = z.object({
	trackId: id,
	artistId: id.nullish(),
	albumId: id.nullish(),
	startedAt: z.iso.datetime({ offset: true }),
	endedAt: z.iso.datetime({ offset: true }).nullish(),
	msPlayed: z.number().int().min(0).max(MAX_PLAYED_MS),
	durationMs: z.number().int().positive().max(MAX_PLAYED_MS).nullish(),
	endReason: z.enum(LISTEN_END_REASONS),
	client: z.string().trim().min(1).max(16),
	shuffle: z.boolean().optional(),
	source: z.string().trim().min(1).max(128).nullish(),
});

const bodySchema = z.object({
	events: z.array(listenSchema).min(1).max(MAX_LISTENS_PER_REQUEST),
});

// POST /api/v1/listens — append finished plays to the listening log
// (recommendation signals). Sent by the player when a play ends, with
// fetch keepalive on the web so a closing tab still reports its last one.
// Events too old or from the future are dropped (counted in `dropped`).
export async function POST(request: NextRequest) {
	try {
		const userResult = await requireUser(request);
		if (userResult.error) return userResult.error;
		const userId = userResult.userId;

		const parsed = bodySchema.safeParse(await request.json().catch(() => null));
		if (!parsed.success) {
			return fail("INVALID_BODY", `events: 1 to ${MAX_LISTENS_PER_REQUEST} valid listens are required.`, 400);
		}

		const now = Date.now();
		const rows = parsed.data.events.flatMap((e) => {
			const startedAt = new Date(e.startedAt);
			const endedAt = e.endedAt ? new Date(e.endedAt) : new Date(now);
			if (
				startedAt.getTime() > now + FUTURE_SKEW_MS ||
				startedAt.getTime() < now - MAX_AGE_MS ||
				endedAt.getTime() < startedAt.getTime()
			) {
				return [];
			}
			return [
				{
					userId,
					trackId: e.trackId,
					artistId: e.artistId ?? null,
					albumId: e.albumId ?? null,
					startedAt,
					endedAt: endedAt.getTime() > now ? new Date(now) : endedAt,
					msPlayed: e.msPlayed,
					durationMs: e.durationMs ?? null,
					endReason: e.endReason,
					client: e.client,
					shuffle: e.shuffle ?? false,
					source: e.source ?? null,
				},
			];
		});

		if (rows.length > 0) await prisma.listenEvent.createMany({ data: rows });

		return ok({ stored: rows.length, dropped: parsed.data.events.length - rows.length });
	} catch (e) {
		return handleError(e);
	}
}
