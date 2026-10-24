// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest";
import { prismaMock, resetPrismaMock } from "@/test/helpers/mockPrisma";
import { authMock, setSessionUser, clearSession } from "@/test/helpers/mockAuth";
import { makeNextRequest, makeParams, readJson } from "@/test/helpers/nextRequest";

vi.mock("@/lib/prisma", () => ({ prisma: prismaMock }));
vi.mock("@/lib/auth", () => ({ auth: authMock }));
vi.mock("@/lib/object-stream", () => ({ getPresignedUrl: vi.fn(async (p: string) => ({ url: `https://r2.example/${p}?sig=1`, contentType: "video/mp4" })) }));

import { GET } from "./route";
import { getPresignedUrl } from "@/lib/object-stream";
import { STORY_TTL_MS } from "@/lib/story/story-render";

type Body = { data: Record<string, unknown>; error: { code: string } };

const base = {
	id: "r1",
	userId: "u1",
	trackId: "42",
	theme: "minimal",
	startMs: 1_700,
	endMs: 9_000,
	progress: 0,
	storagePath: null,
	size: null,
	error: null,
	createdAt: new Date(),
	updatedAt: new Date(),
	readyAt: null,
};

const get = (id = "r1") => GET(makeNextRequest(), makeParams({ renderId: id }));

beforeEach(() => {
	resetPrismaMock();
	clearSession();
	vi.mocked(getPresignedUrl).mockClear();
	prismaMock.storyRender.updateMany.mockResolvedValue({ count: 0 });
});

describe("GET /api/v1/stories/{renderId}", () => {
	it("needs a signed-in user", async () => {
		expect((await get()).status).toBe(401);
	});

	it("answers 404 for another user's render, looked up within the caller's own", async () => {
		setSessionUser("u2");
		prismaMock.storyRender.findFirst.mockResolvedValue(null);
		const res = await get();
		expect(res.status).toBe(404);
		expect(prismaMock.storyRender.findFirst.mock.calls[0][0]).toEqual({ where: { id: "r1", userId: "u2" } });
	});

	it("shows a render in progress without a link", async () => {
		setSessionUser("u1");
		prismaMock.storyRender.findFirst.mockResolvedValue({ ...base, status: "rendering", progress: 0.4 });
		const res = await get();
		expect((await readJson<Body>(res))?.data).toMatchObject({ status: "rendering", progress: 0.4, url: null });
		expect(getPresignedUrl).not.toHaveBeenCalled();
	});

	it("gives a ready render a one-hour presigned link", async () => {
		setSessionUser("u1");
		prismaMock.storyRender.findFirst.mockResolvedValue({ ...base, status: "ready", progress: 1, readyAt: new Date(), storagePath: "stories/u1/r1.mp4", size: 1_800_000 });
		const data = (await readJson<Body>(await get()))?.data;
		expect(data).toMatchObject({ status: "ready", url: "https://r2.example/stories/u1/r1.mp4?sig=1", size: 1_800_000 });
		expect(getPresignedUrl).toHaveBeenCalledWith("stories/u1/r1.mp4", 3600);
		expect(typeof data?.urlExpiresAt).toBe("string");
	});

	it("shows a render older than 24 h as expired, without signing a link", async () => {
		setSessionUser("u1");
		prismaMock.storyRender.findFirst.mockResolvedValue({ ...base, status: "ready", readyAt: new Date(Date.now() - STORY_TTL_MS - 1000), storagePath: "stories/u1/r1.mp4" });
		expect((await readJson<Body>(await get()))?.data).toMatchObject({ status: "expired", url: null });
		expect(getPresignedUrl).not.toHaveBeenCalled();
	});

	it("fails the caller's stuck renders before answering (was: a render killed with its function stayed 'rendering' forever)", async () => {
		setSessionUser("u1");
		prismaMock.storyRender.findFirst.mockResolvedValue({ ...base, status: "failed", error: "TIMED_OUT" });
		const data = (await readJson<Body>(await get()))?.data;
		expect(prismaMock.storyRender.updateMany.mock.calls[0][0].where.userId).toBe("u1");
		expect(data).toMatchObject({ status: "failed", error: "TIMED_OUT" });
	});
});
