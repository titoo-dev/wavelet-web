import { describe, it, expect, vi, beforeEach } from "vitest";
import { prismaMock, resetPrismaMock } from "@/test/helpers/mockPrisma";
import { authMock, setSessionUser, clearSession } from "@/test/helpers/mockAuth";
import { makeNextRequest, makeParams, readJson } from "@/test/helpers/nextRequest";

vi.mock("@/lib/prisma", () => ({ prisma: prismaMock }));
vi.mock("@/lib/auth", () => ({ auth: authMock }));
vi.mock("@/lib/library", () => ({
	unsaveTrack: vi.fn(),
	isTrackSaved: vi.fn(),
}));

import { GET, DELETE } from "./route";
import { unsaveTrack, isTrackSaved } from "@/lib/library";

const unsaveTrackMock = vi.mocked(unsaveTrack);
const isTrackSavedMock = vi.mocked(isTrackSaved);

beforeEach(() => {
	resetPrismaMock();
	clearSession();
	unsaveTrackMock.mockReset();
	isTrackSavedMock.mockReset();
});

describe("GET /api/v1/library/tracks/[trackId]", () => {
	it("returns 401 when not authenticated", async () => {
		const res = await GET(makeNextRequest(), makeParams({ trackId: "t1" }));
		expect(res.status).toBe(401);
	});

	it("returns { saved: true } when the track is saved", async () => {
		setSessionUser("u1");
		isTrackSavedMock.mockResolvedValue(true);

		const res = await GET(makeNextRequest(), makeParams({ trackId: "t1" }));
		expect(res.status).toBe(200);
		const body = await readJson<{ data: { saved: boolean } }>(res);
		expect(body?.data.saved).toBe(true);
		expect(isTrackSavedMock).toHaveBeenCalledWith("u1", "t1");
	});

	it("returns { saved: false } when the track is not saved", async () => {
		setSessionUser("u1");
		isTrackSavedMock.mockResolvedValue(false);

		const res = await GET(makeNextRequest(), makeParams({ trackId: "t1" }));
		expect(res.status).toBe(200);
		const body = await readJson<{ data: { saved: boolean } }>(res);
		expect(body?.data.saved).toBe(false);
	});
});

describe("DELETE /api/v1/library/tracks/[trackId]", () => {
	it("returns 401 when not authenticated", async () => {
		const res = await DELETE(
			makeNextRequest({ method: "DELETE" }),
			makeParams({ trackId: "t1" })
		);
		expect(res.status).toBe(401);
		const body = await readJson<{ error: { code: string } }>(res);
		expect(body?.error.code).toBe("NOT_AUTHENTICATED");
	});

	it("calls unsaveTrack with userId + trackId and returns { unsaved: true }", async () => {
		setSessionUser("u1");
		unsaveTrackMock.mockResolvedValue(undefined);

		const res = await DELETE(
			makeNextRequest({ method: "DELETE" }),
			makeParams({ trackId: "t-delete" })
		);
		expect(res.status).toBe(200);
		const body = await readJson<{ data: { unsaved: boolean } }>(res);
		expect(body?.data.unsaved).toBe(true);
		expect(unsaveTrackMock).toHaveBeenCalledWith("u1", "t-delete");
	});

	it("returns 500 when unsaveTrack throws", async () => {
		setSessionUser("u1");
		unsaveTrackMock.mockRejectedValue(new Error("boom"));

		const res = await DELETE(
			makeNextRequest({ method: "DELETE" }),
			makeParams({ trackId: "t1" })
		);
		expect(res.status).toBe(500);
		const body = await readJson<{ error: { code: string } }>(res);
		expect(body?.error.code).toBe("INTERNAL_ERROR");
	});
});
