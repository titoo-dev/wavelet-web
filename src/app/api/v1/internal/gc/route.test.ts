// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { makeNextRequest, readJson } from "@/test/helpers/nextRequest";

const { gcMock, storyGcMock, deleteFile } = vi.hoisted(() => ({ gcMock: vi.fn(), storyGcMock: vi.fn(), deleteFile: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/auth", () => ({ auth: {} }));
vi.mock("@/lib/wavelet/storage/gc", () => ({ collectStorageGarbage: gcMock }));
vi.mock("@/lib/story/story-render", () => ({ collectStoryGarbage: storyGcMock }));
vi.mock("@/lib/wavelet/storage/factory", () => ({ createStorageProvider: () => ({ deleteFile }) }));

import { GET } from "./route";

const url = "http://localhost:3000/api/v1/internal/gc";

describe("GET /api/v1/internal/gc", () => {
	beforeEach(() => {
		gcMock.mockReset();
		deleteFile.mockReset();
		storyGcMock.mockReset();
		storyGcMock.mockResolvedValue({ objectsDeleted: 0, rowsPurged: 0, stuckFailed: 0, errors: 0 });
		vi.stubEnv("CRON_SECRET", "s3cret");
	});
	afterEach(() => vi.unstubAllEnvs());

	it("is a no-op while CRON_SECRET is unset", async () => {
		vi.stubEnv("CRON_SECRET", "");
		const res = await GET(makeNextRequest({ url }));
		expect(res.status).toBe(200);
		expect(await readJson(res)).toMatchObject({ data: { ran: false } });
		expect(gcMock).not.toHaveBeenCalled();
	});

	it.each([undefined, "Bearer wrong", "s3cret", "Bearer s3cret2"])("answers 401 for authorization %s", async (authorization) => {
		const res = await GET(makeNextRequest({ url, headers: authorization ? { authorization } : {} }));
		expect(res.status).toBe(401);
		expect(gcMock).not.toHaveBeenCalled();
	});

	it("runs the collection with the cron secret and reports what it deleted", async () => {
		gcMock.mockImplementation(async ({ deleteObject }) => {
			await deleteObject("tracks/1/1.mp3");
			return { rowsDeleted: 1, objectsDeleted: 1, objectsScanned: 3, orphanObjectsDeleted: 0 };
		});
		const res = await GET(makeNextRequest({ url, headers: { authorization: "Bearer s3cret" } }));
		expect(res.status).toBe(200);
		expect(await readJson(res)).toEqual({
			success: true,
			data: {
				ran: true,
				rowsDeleted: 1,
				objectsDeleted: 1,
				objectsScanned: 3,
				orphanObjectsDeleted: 0,
				stories: { objectsDeleted: 0, rowsPurged: 0, stuckFailed: 0, errors: 0 },
			},
		});
		expect(deleteFile).toHaveBeenCalledWith("tracks/1/1.mp3");
	});

	it("also collects the Lyrics Stories past their 24 h, deleting through the same storage", async () => {
		gcMock.mockResolvedValue({ rowsDeleted: 0, objectsDeleted: 0, objectsScanned: 0, orphanObjectsDeleted: 0 });
		storyGcMock.mockImplementation(async (deleteObject: (k: string) => Promise<void>) => {
			await deleteObject("stories/u1/r1.mp4");
			return { objectsDeleted: 1, rowsPurged: 2, stuckFailed: 1, errors: 0 };
		});
		const res = await GET(makeNextRequest({ url, headers: { authorization: "Bearer s3cret" } }));
		expect(await readJson(res)).toMatchObject({ data: { stories: { objectsDeleted: 1, rowsPurged: 2, stuckFailed: 1 } } });
		expect(deleteFile).toHaveBeenCalledWith("stories/u1/r1.mp4");
	});

	it("answers a generic 500 when the collection fails", async () => {
		gcMock.mockRejectedValue(new Error("db password in message"));
		const res = await GET(makeNextRequest({ url, headers: { authorization: "Bearer s3cret" } }));
		expect(res.status).toBe(500);
		expect(await readJson(res)).toEqual({ success: false, error: { code: "INTERNAL_ERROR", message: "Garbage collection failed." } });
	});
});
