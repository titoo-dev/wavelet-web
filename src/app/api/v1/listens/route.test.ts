import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { prismaMock, resetPrismaMock } from "@/test/helpers/mockPrisma";
import { authMock, setSessionUser, clearSession } from "@/test/helpers/mockAuth";
import { makeNextRequest, readJson } from "@/test/helpers/nextRequest";

vi.mock("@/lib/prisma", () => ({ prisma: prismaMock }));
vi.mock("@/lib/auth", () => ({ auth: authMock }));

import { POST } from "./route";

const NOW = new Date("2026-10-20T12:00:00.000Z");

function listen(over: Record<string, unknown> = {}) {
	return {
		trackId: "3135556",
		artistId: "27",
		albumId: "302127",
		startedAt: "2026-10-20T11:56:00.000Z",
		endedAt: "2026-10-20T11:59:30.000Z",
		msPlayed: 210_000,
		durationMs: 212_000,
		endReason: "completed",
		client: "web",
		shuffle: true,
		...over,
	};
}

function post(body: unknown) {
	return POST(makeNextRequest({ method: "POST", body }));
}

beforeEach(() => {
	resetPrismaMock();
	clearSession();
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(NOW);
	prismaMock.listenEvent.createMany.mockResolvedValue({ count: 1 });
});

afterEach(() => {
	vi.useRealTimers();
});

describe("POST /api/v1/listens", () => {
	it("returns 401 when not authenticated", async () => {
		const res = await post({ events: [listen()] });
		expect(res.status).toBe(401);
		expect(prismaMock.listenEvent.createMany).not.toHaveBeenCalled();
	});

	it("stores the listens for the signed-in user", async () => {
		setSessionUser("u1");
		const res = await post({ events: [listen()] });
		expect(res.status).toBe(200);
		expect((await readJson<{ data: unknown }>(res))?.data).toEqual({ stored: 1, dropped: 0 });
		expect(prismaMock.listenEvent.createMany).toHaveBeenCalledWith({
			data: [
				{
					userId: "u1",
					trackId: "3135556",
					artistId: "27",
					albumId: "302127",
					startedAt: new Date("2026-10-20T11:56:00.000Z"),
					endedAt: new Date("2026-10-20T11:59:30.000Z"),
					msPlayed: 210_000,
					durationMs: 212_000,
					endReason: "completed",
					client: "web",
					shuffle: true,
					source: null,
				},
			],
		});
	});

	it("never takes the user from the body", async () => {
		setSessionUser("u1");
		await post({ events: [listen({ userId: "someone-else" })] });
		expect(prismaMock.listenEvent.createMany.mock.calls[0][0].data[0].userId).toBe("u1");
	});

	it("fills the optional fields: ended now, no shuffle, no ids", async () => {
		setSessionUser("u1");
		await post({
			events: [
				{ trackId: "1", startedAt: "2026-10-20T11:59:50Z", msPlayed: 4000, endReason: "skipped", client: "android" },
			],
		});
		expect(prismaMock.listenEvent.createMany.mock.calls[0][0].data[0]).toMatchObject({
			artistId: null,
			albumId: null,
			durationMs: null,
			endedAt: NOW,
			shuffle: false,
			source: null,
		});
	});

	it.each([
		["no body", undefined],
		["no events", {}],
		["an empty batch", { events: [] }],
		["more than 50 events", { events: Array.from({ length: 51 }, () => listen()) }],
		["an unknown end reason", { events: [listen({ endReason: "paused" })] }],
		["a negative msPlayed", { events: [listen({ msPlayed: -1 })] }],
		["a fractional msPlayed", { events: [listen({ msPlayed: 1.5 })] }],
		["a startedAt that is not a date", { events: [listen({ startedAt: "yesterday" })] }],
		["an empty trackId", { events: [listen({ trackId: "" })] }],
		["no client", { events: [listen({ client: undefined })] }],
	])("returns 400 INVALID_BODY for %s", async (_label, body) => {
		setSessionUser("u1");
		const res = body === undefined ? await POST(makeNextRequest({ method: "POST" })) : await post(body);
		expect(res.status).toBe(400);
		expect((await readJson<{ error: { code: string } }>(res))?.error.code).toBe("INVALID_BODY");
		expect(prismaMock.listenEvent.createMany).not.toHaveBeenCalled();
	});

	it("drops listens from the future, older than 30 days, or ending before they started", async () => {
		setSessionUser("u1");
		const res = await post({
			events: [
				listen({ startedAt: "2026-10-20T12:10:00Z", endedAt: null }),
				listen({ startedAt: "2026-09-01T12:00:00Z", endedAt: "2026-09-01T12:03:00Z" }),
				listen({ startedAt: "2026-10-20T11:50:00Z", endedAt: "2026-10-20T11:40:00Z" }),
				listen(),
			],
		});
		expect((await readJson<{ data: unknown }>(res))?.data).toEqual({ stored: 1, dropped: 3 });
		expect(prismaMock.listenEvent.createMany.mock.calls[0][0].data).toHaveLength(1);
	});

	it("does not write anything when every listen was dropped", async () => {
		setSessionUser("u1");
		const res = await post({ events: [listen({ startedAt: "2025-01-01T00:00:00Z", endedAt: null })] });
		expect(res.status).toBe(200);
		expect(prismaMock.listenEvent.createMany).not.toHaveBeenCalled();
	});

	it("caps an endedAt slightly ahead of the server clock to now", async () => {
		setSessionUser("u1");
		await post({ events: [listen({ startedAt: "2026-10-20T11:58:00Z", endedAt: "2026-10-20T12:02:00Z" })] });
		expect(prismaMock.listenEvent.createMany.mock.calls[0][0].data[0].endedAt).toEqual(NOW);
	});

	it("returns the generic 500 when the database fails", async () => {
		setSessionUser("u1");
		prismaMock.listenEvent.createMany.mockRejectedValue(new Error("db down"));
		const res = await post({ events: [listen()] });
		expect(res.status).toBe(500);
	});
});
