import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { describeErrorForLog } from "@/lib/log-safe";
import { fromApiTrack, signalsFrom, type AutoplayTrack } from "@/lib/autoplay";
import { buildDailyMix, flowMix, seededShuffle, seedsOfDay, topArtists, type DailyMix } from "@/lib/daily-mix";
import { normName, similarLists } from "@/lib/similar";
import { requireUser, getGuestOrUserDz, ok, fail, handleError } from "../../_lib/helpers";

const RADIO_SIZE = 50;
const SIGNALS_WINDOW_MS = 60 * 24 * 60 * 60 * 1000;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

const apiTracks = (v: unknown): AutoplayTrack[] => {
	const data = (v as { data?: unknown[] } | null)?.data;
	return Array.isArray(data) ? data.map(fromApiTrack).filter((t): t is AutoplayTrack => t !== null) : [];
};

// GET /api/v1/mixes/daily?day=YYYY-MM-DD[&refresh=1] — the user's Daily Mix
// for their day (the client's date; the server's UTC date when missing).
// Built on the first call of the day, then served from the cache until the
// day changes or `refresh=1`. `tracks` is empty while there is nothing to
// build it from (no history, no follows, no Deezer Flow).
export async function GET(request: NextRequest) {
	try {
		const userResult = await requireUser(request);
		if (userResult.error) return userResult.error;
		const userId = userResult.userId;

		const params = request.nextUrl.searchParams;
		const asked = params.get("day");
		if (asked !== null && (!DAY.test(asked) || Number.isNaN(Date.parse(asked)))) {
			return fail("INVALID_DAY", "day must be a YYYY-MM-DD date.", 400);
		}
		const day = asked ?? new Date().toISOString().slice(0, 10);
		const refresh = params.get("refresh") === "1";

		const cached = await prisma.dailyMix.findUnique({ where: { userId } });
		if (cached && cached.day === day && !refresh) return ok(cached.payload as unknown as DailyMix);

		const { dz, userId: dzUserId } = await getGuestOrUserDz(request);
		if (!dz) {
			// Yesterday's mix beats none.
			if (cached) return ok(cached.payload as unknown as DailyMix);
			return fail("NO_DEEZER", "Deezer is not available. Sign in or configure a service ARL.", 503);
		}

		const now = Date.now();
		const [listens, followed, saved, recent] = await Promise.all([
			prisma.listenEvent.findMany({
				where: { userId, startedAt: { gte: new Date(now - SIGNALS_WINDOW_MS) } },
				select: { trackId: true, artistId: true, endReason: true, msPlayed: true, startedAt: true },
				orderBy: { startedAt: "desc" },
				take: 5000,
			}),
			prisma.followedArtist.findMany({ where: { userId }, select: { deezerArtistId: true, name: true } }),
			prisma.savedTrack.findMany({ where: { userId }, orderBy: { savedAt: "desc" }, take: 500 }),
			prisma.recentPlay.findMany({ where: { userId }, orderBy: { playedAt: "desc" }, take: 100 }),
		]);
		const signals = signalsFrom(listens, now);
		const seeds = seedsOfDay(topArtists(listens, followed), day);

		let mix: DailyMix;
		if (seeds.length > 0) {
			const radios = await Promise.allSettled(seeds.map((s) => dz.api.get_artist_radio(s.artistId, { limit: RADIO_SIZE })));
			const lists = radios.map((r) => {
				if (r.status === "fulfilled") return apiTracks(r.value);
				console.warn("[daily-mix] artist radio failed:", describeErrorForLog(r.reason));
				return [];
			});
			// A seed known only from the listening log gets its name from its own radio.
			const artists = seeds.map(
				(s, i) => s.name ?? lists[i].find((t) => t.artistId === s.artistId)?.artist ?? null
			);
			const familiar: AutoplayTrack[] = [...saved, ...recent].map((t) => ({
				trackId: t.trackId,
				title: t.title,
				artist: t.artist,
				artistId: null,
				album: t.album,
				albumId: t.albumId,
				cover: t.coverUrl,
				duration: t.duration,
			}));
			const names = artists.filter((a): a is string => !!a);
			// ListenBrainz / Last.fm similar tracks to two loved tracks of the day's artists
			// (else to the artists' own first radio tracks), after the first radio.
			const wanted = new Set(names.map(normName));
			const loved = seededShuffle(
				familiar.filter((t) => wanted.has(normName(t.artist))),
				`${userId}:${day}`
			).map((t) => t.trackId);
			const own = seeds.flatMap((s, i) => lists[i].filter((t) => t.artistId === s.artistId).slice(0, 1).map((t) => t.trackId));
			const similar = await similarLists(dz.api, [...new Set([...loved, ...own])].slice(0, 2));
			mix = {
				day,
				basedOn: "taste",
				artists: names,
				tracks: buildDailyMix({
					familiar,
					seedNames: names,
					radios: [...lists.slice(0, 1), ...similar, ...lists.slice(1)],
					signals,
					seed: `${userId}:${day}`,
				}),
			};
		} else {
			// No history yet: Deezer's Flow, for the user's own Deezer account only.
			const deezerUserId = dzUserId === userId ? dz.currentUser?.id : undefined;
			const flow = deezerUserId
				? await dz.api.get_user_flow(deezerUserId, { limit: 50 }).then(apiTracks, (e) => {
						console.warn("[daily-mix] flow failed:", describeErrorForLog(e));
						return [];
					})
				: [];
			mix = { day, basedOn: "flow", artists: [], tracks: flowMix(flow, signals) };
		}

		if (mix.tracks.length === 0) {
			if (cached) return ok(cached.payload as unknown as DailyMix);
			return ok(mix);
		}
		const payload = JSON.parse(JSON.stringify(mix));
		await prisma.dailyMix.upsert({
			where: { userId },
			update: { day, payload, createdAt: new Date(now) },
			create: { userId, day, payload },
		});
		return ok(mix);
	} catch (e) {
		return handleError(e);
	}
}
