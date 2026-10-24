// Story Renders (CONTEXT.md): a row per request in Postgres, the render itself in the route's
// `after()` (docs/adr/0004), the MP4 in R2 for 24 h. Guardrails of docs/adr/0006: one render at a
// time per user, 20 a day (failures not counted), the same request within 24 h reuses its render.
import { createHash } from "crypto";
import { readFile, rm, stat } from "fs/promises";
import os from "os";
import path from "path";
import { prisma } from "@/lib/prisma";
import { STORIES_PREFIX } from "@/lib/wavelet/storage/objects";
import { AudioUnavailableError, defaultAudioSourceDeps, fetchExcerptAudio, type AudioSourceDeps } from "./audio-source";
import type { LyricsRange, StoryLine } from "./range";
import { RenderFailedError, renderStoryVideo } from "./render";
import { loadCover } from "./still";
import type { StoryThemeId } from "./themes";

/** A ready Lyrics Story can be downloaded this long. */
export const STORY_TTL_MS = 24 * 60 * 60 * 1000;
/** Rows are purged after this. */
export const STORY_ROW_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** A render silent this long died with its function (after() is not durable): it is failed. */
export const STUCK_RENDER_MS = 6 * 60 * 1000;
export const DAILY_RENDER_LIMIT = 20;
const DAY_MS = 24 * 60 * 60 * 1000;

export type StoryRenderStatus = "queued" | "rendering" | "ready" | "failed";
const ACTIVE: StoryRenderStatus[] = ["queued", "rendering"];

/** The row as Prisma returns it (the fields this module reads). */
export interface StoryRenderRow {
	id: string;
	userId: string;
	trackId: string;
	theme: string;
	startMs: number;
	endMs: number;
	status: string;
	progress: number;
	storagePath: string | null;
	size: number | null;
	error: string | null;
	createdAt: Date;
	updatedAt: Date;
	readyAt: Date | null;
}

export interface StoryRenderInput {
	trackId: string;
	theme: StoryThemeId;
	title: string;
	artist: string;
	coverUrl: string | null;
	trackDurationMs: number;
	nextLineMs: number | null;
	range: LyricsRange;
}

/** Same track, range, theme and lines → same hash. */
export function linesHash(lines: StoryLine[]): string {
	return createHash("sha256").update(JSON.stringify(lines.map((l) => [l.timeMs, l.text]))).digest("hex");
}

export function storyObjectKey(userId: string, renderId: string): string {
	return `${STORIES_PREFIX}${userId}/${renderId}.mp4`;
}

/** Fails the user's renders (or everyone's) that went silent past STUCK_RENDER_MS. */
export async function failStuckRenders(now: Date, userId?: string): Promise<number> {
	const { count } = await prisma.storyRender.updateMany({
		where: { ...(userId ? { userId } : {}), status: { in: ACTIVE }, updatedAt: { lt: new Date(now.getTime() - STUCK_RENDER_MS) } },
		data: { status: "failed", error: "TIMED_OUT" },
	});
	return count;
}

export type RequestRenderResult =
	| { kind: "reused"; render: StoryRenderRow }
	| { kind: "created"; render: StoryRenderRow }
	| { kind: "busy"; render: StoryRenderRow }
	| { kind: "limit" };

/**
 * Reuses the same request's live render (queued, rendering, or ready less than 24 h ago), else
 * creates one, unless another render of the user is under way or the day's 20 are used.
 */
export async function requestRender(userId: string, input: StoryRenderInput, now = new Date()): Promise<RequestRenderResult> {
	await failStuckRenders(now, userId);
	const hash = linesHash(input.range.lines);
	const same = (await prisma.storyRender.findFirst({
		where: {
			userId,
			trackId: input.trackId,
			theme: input.theme,
			startMs: input.range.startMs,
			endMs: input.range.endMs,
			linesHash: hash,
			OR: [{ status: { in: ACTIVE } }, { status: "ready", readyAt: { gt: new Date(now.getTime() - STORY_TTL_MS) } }],
		},
		orderBy: { createdAt: "desc" },
	})) as StoryRenderRow | null;
	if (same) return { kind: "reused", render: same };

	const running = (await prisma.storyRender.findFirst({ where: { userId, status: { in: ACTIVE } } })) as StoryRenderRow | null;
	if (running) return { kind: "busy", render: running };

	const today = await prisma.storyRender.count({
		where: { userId, status: { not: "failed" }, createdAt: { gt: new Date(now.getTime() - DAY_MS) } },
	});
	if (today >= DAILY_RENDER_LIMIT) return { kind: "limit" };

	const render = (await prisma.storyRender.create({
		data: {
			userId,
			trackId: input.trackId,
			theme: input.theme,
			startMs: input.range.startMs,
			endMs: input.range.endMs,
			linesHash: hash,
			lines: input.range.lines as unknown as object,
			title: input.title,
			artist: input.artist,
			coverUrl: input.coverUrl,
			trackDurationMs: input.trackDurationMs,
			nextLineMs: input.nextLineMs,
		},
	})) as StoryRenderRow;
	return { kind: "created", render };
}

export interface RunRenderDeps {
	audio: AudioSourceDeps;
	upload(key: string, data: Buffer): Promise<void>;
	render: typeof renderStoryVideo;
	loadCover: typeof loadCover;
	tmpDir: string;
}

const defaultRunDeps = (): RunRenderDeps => ({
	audio: defaultAudioSourceDeps,
	async upload(key, data) {
		const { createStorageProvider } = await import("@/lib/wavelet/storage/factory");
		await createStorageProvider().writeFile(key, data);
	},
	render: renderStoryVideo,
	loadCover,
	tmpDir: os.tmpdir(),
});

/** Progress is written about every 10 %: enough for a progress bar, few writes. */
const PROGRESS_STEP = 0.1;

/**
 * Renders a queued Story Render: audio excerpt → frames + ffmpeg → R2. Ends ready, or failed with
 * an error code for the client (NO_DEEZER, AUDIO_UNAVAILABLE, RENDER_FAILED). Never throws.
 */
export async function runRender(id: string, deps: RunRenderDeps = defaultRunDeps()): Promise<void> {
	const claimed = await prisma.storyRender.updateMany({ where: { id, status: "queued" }, data: { status: "rendering", progress: 0 } });
	if (claimed.count === 0) return; // already taken, or gone
	const row = await prisma.storyRender.findUnique({ where: { id } });
	if (!row) return;

	const audioFile = path.join(deps.tmpDir, `story-${id}.audio`);
	const outFile = path.join(deps.tmpDir, `story-${id}.mp4`);
	let audio: { cleanup(): Promise<void> } | null = null;
	try {
		const lines = row.lines as unknown as StoryLine[];
		const range: LyricsRange = { lines, startMs: row.startMs, endMs: row.endMs, durationMs: row.endMs - row.startMs };
		const [excerpt, cover] = await Promise.all([
			fetchExcerptAudio({ userId: row.userId, trackId: row.trackId, endMs: row.endMs, trackDurationMs: row.trackDurationMs, file: audioFile }, deps.audio),
			deps.loadCover(row.coverUrl),
		]);
		audio = excerpt;

		let saved = 0;
		await deps.render({
			story: { range, theme: row.theme as StoryThemeId, title: row.title, artist: row.artist, cover },
			audioFile,
			outFile,
			onProgress: (p) => {
				// Drawing is ~95 % of the work; the upload is the rest.
				const progress = Math.round(p * 0.95 * 100) / 100;
				if (progress - saved < PROGRESS_STEP) return;
				saved = progress;
				void prisma.storyRender.update({ where: { id }, data: { progress } }).catch(() => {});
			},
		});

		const data = await readFile(outFile);
		const key = storyObjectKey(row.userId, id);
		await deps.upload(key, data);
		await prisma.storyRender.update({
			where: { id },
			data: { status: "ready", progress: 1, storagePath: key, size: (await stat(outFile)).size, readyAt: new Date(), error: null },
		});
	} catch (e) {
		const code = e instanceof AudioUnavailableError ? e.code : "RENDER_FAILED";
		if (!(e instanceof AudioUnavailableError || e instanceof RenderFailedError)) console.error("[story-render] failed:", e);
		else console.warn(`[story-render] ${id} failed: ${e.message}`);
		await prisma.storyRender.update({ where: { id }, data: { status: "failed", error: code } }).catch(() => {});
	} finally {
		await audio?.cleanup().catch(() => {});
		await rm(outFile, { force: true }).catch(() => {});
		await rm(audioFile, { force: true }).catch(() => {});
	}
}

export type PublicStatus = StoryRenderStatus | "expired";

/** What the API shows of a render; `url` only while it can be downloaded. */
export function publicRender(row: StoryRenderRow, now: Date, url: string | null = null) {
	const expiresAt = row.readyAt ? new Date(row.readyAt.getTime() + STORY_TTL_MS) : null;
	const expired = row.status === "ready" && (!expiresAt || expiresAt <= now || !row.storagePath);
	const status: PublicStatus = expired ? "expired" : (row.status as StoryRenderStatus);
	return {
		id: row.id,
		status,
		progress: row.progress,
		trackId: row.trackId,
		theme: row.theme,
		startMs: row.startMs,
		endMs: row.endMs,
		createdAt: row.createdAt.toISOString(),
		readyAt: row.readyAt?.toISOString() ?? null,
		expiresAt: expiresAt?.toISOString() ?? null,
		size: status === "ready" ? row.size : null,
		url: status === "ready" ? url : null,
		error: row.status === "failed" ? (row.error ?? "RENDER_FAILED") : null,
	};
}

/**
 * Deletes the MP4s past STORY_TTL_MS (the row stays, as expired), purges rows past
 * STORY_ROW_TTL_MS with their object, and fails stuck renders. For the daily GC cron.
 */
export async function collectStoryGarbage(deleteObject: (key: string) => Promise<void>, now = new Date()) {
	const expiredBefore = new Date(now.getTime() - STORY_TTL_MS);
	const purgeBefore = new Date(now.getTime() - STORY_ROW_TTL_MS);
	let objectsDeleted = 0;
	let errors = 0;

	const withObject = await prisma.storyRender.findMany({
		where: { storagePath: { not: null }, OR: [{ readyAt: { lt: expiredBefore } }, { createdAt: { lt: purgeBefore } }] },
		select: { id: true, storagePath: true },
		take: 1000,
	});
	for (const r of withObject) {
		try {
			await deleteObject(r.storagePath as string);
			await prisma.storyRender.update({ where: { id: r.id }, data: { storagePath: null } });
			objectsDeleted++;
		} catch {
			errors++;
		}
	}
	const { count: rowsPurged } = await prisma.storyRender.deleteMany({ where: { createdAt: { lt: purgeBefore }, storagePath: null } });
	const stuckFailed = await failStuckRenders(now);
	return { objectsDeleted, rowsPurged, stuckFailed, errors };
}
