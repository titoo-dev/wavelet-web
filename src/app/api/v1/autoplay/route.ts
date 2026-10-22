import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { describeErrorForLog } from "@/lib/log-safe";
import { fromApiTrack, pickAutoplay, signalsFrom, type AutoplayTrack } from "@/lib/autoplay";
import { similarLists } from "@/lib/similar";
import { requireUser, getGuestOrUserDz, ok, fail, handleError } from "../_lib/helpers";

const id = z.union([z.string().trim().regex(/^\d{1,20}$/), z.number().int().positive()]).transform(String);

const bodySchema = z.object({
	/** Most recent first: the track playing, then the ones before it. */
	seeds: z.array(z.object({ trackId: id, artistId: id.nullish() })).min(1).max(5),
	/** Already queued: never offered. */
	exclude: z.array(z.union([z.string(), z.number()]).transform(String)).max(1000).default([]),
	limit: z.number().int().min(1).max(50).default(20),
});

/** Seed artists whose radios are mixed (the first one leads). */
const MAX_SEED_ARTISTS = 3;
const RADIO_SIZE = 40;
/** How far back the listening log is read. */
const SIGNALS_WINDOW_MS = 60 * 24 * 60 * 60 * 1000;

// POST /api/v1/autoplay — tracks to play once the queue runs out: Deezer's
// radios of the seed artists, without what is queued, what this user skips
// early or played in the last hours, at most 2 per artist.
export async function POST(request: NextRequest) {
	try {
		const userResult = await requireUser(request);
		if (userResult.error) return userResult.error;
		const userId = userResult.userId;

		const parsed = bodySchema.safeParse(await request.json().catch(() => null));
		if (!parsed.success) return fail("INVALID_BODY", "seeds: 1 to 5 Deezer tracks are required.", 400);
		const { exclude, limit } = parsed.data;
		// (zod infers every field optional without strictNullChecks)
		const seeds = parsed.data.seeds as Seed[];

		const { dz } = await getGuestOrUserDz(request);
		if (!dz) return fail("NO_DEEZER", "Deezer is not available. Sign in or configure a service ARL.", 503);

		const now = Date.now();
		const [artistIds, listens] = await Promise.all([
			seedArtists(dz.api, seeds),
			prisma.listenEvent.findMany({
				where: { userId, startedAt: { gte: new Date(now - SIGNALS_WINDOW_MS) } },
				select: { trackId: true, artistId: true, endReason: true, msPlayed: true, startedAt: true },
				orderBy: { startedAt: "desc" },
				take: 5000,
			}),
		]);
		if (artistIds.length === 0) return fail("NOT_FOUND", "None of the seed tracks is known to Deezer.", 404);

		// ListenBrainz / Last.fm similar tracks to the track playing, next to the radios.
		const [radios, similar] = await Promise.all([
			Promise.allSettled(artistIds.map((artistId) => dz.api.get_artist_radio(artistId, { limit: RADIO_SIZE }))),
			similarLists(dz.api, [seeds[0].trackId]),
		]);
		const radioLists: AutoplayTrack[][] = radios.flatMap((r) => {
			if (r.status === "rejected") {
				console.warn("[autoplay] artist radio failed:", describeErrorForLog(r.reason));
				return [];
			}
			const data = (r.value as { data?: unknown[] } | null)?.data;
			return [Array.isArray(data) ? data.map(fromApiTrack).filter((t): t is AutoplayTrack => t !== null) : []];
		});
		// The first seed artist's radio leads, the similar tracks come next, then the other radios.
		const lists = [...radioLists.slice(0, 1), ...similar, ...radioLists.slice(1)];
		if (lists.length === 0) return fail("UPSTREAM_ERROR", "Deezer is not reachable right now.", 502);

		const tracks = pickAutoplay(lists, {
			exclude: new Set([...exclude, ...seeds.map((s) => s.trackId)]),
			signals: signalsFrom(listens, now),
			limit,
		});
		return ok({ tracks, seedArtistIds: artistIds });
	} catch (e) {
		return handleError(e);
	}
}

type Seed = { trackId: string; artistId?: string | null };
type DeezerApi = { getTrack(id: string): Promise<{ artist?: { id?: number | string } }> };

/** The seeds' artists, most recent first, each once; a seed without one is looked up (2 at most). */
async function seedArtists(api: DeezerApi, seeds: Seed[]): Promise<string[]> {
	const lookups = seeds.filter((s) => !s.artistId).slice(0, 2);
	const found = new Map<string, string>();
	await Promise.all(
		lookups.map(async (s) => {
			try {
				const artistId = (await api.getTrack(s.trackId))?.artist?.id;
				if (artistId) found.set(s.trackId, String(artistId));
			} catch {
				// An unknown seed is left out.
			}
		})
	);
	const ids: string[] = [];
	for (const s of seeds) {
		const artistId = s.artistId ?? found.get(s.trackId);
		if (artistId && !ids.includes(artistId)) ids.push(artistId);
	}
	return ids.slice(0, MAX_SEED_ARTISTS);
}
