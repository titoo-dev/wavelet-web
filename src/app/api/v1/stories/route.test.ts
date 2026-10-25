// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest";
import { prismaMock } from "@/test/helpers/mockPrisma";
import { authMock, setSessionUser, clearSession } from "@/test/helpers/mockAuth";
import { makeNextRequest, readJson } from "@/test/helpers/nextRequest";

const { afterMock } = vi.hoisted(() => ({ afterMock: vi.fn() }));
vi.mock("next/server", async (importOriginal) => ({ ...(await importOriginal<typeof import("next/server")>()), after: afterMock }));
vi.mock("@/lib/prisma", () => ({ prisma: prismaMock }));
vi.mock("@/lib/auth", () => ({ auth: authMock }));
vi.mock("@/lib/story/story-render", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/story/story-render")>()),
	requestRender: vi.fn(),
	runRender: vi.fn(),
}));

import { POST } from "./route";
import { requestRender, runRender, type StoryRenderRow } from "@/lib/story/story-render";

type Body = { data: Record<string, unknown>; error: { code: string } };

const valid = {
	trackId: "3135556",
	theme: "vinyl",
	title: " Harder,  Better ",
	artist: "Daft Punk",
	coverUrl: "https://evil.example/c.jpg",
	lines: [
		{ timeMs: 60_000, text: "Work it" },
		{ timeMs: 64_000, text: "Make it" },
	],
	nextLineMs: 68_000,
	trackDurationMs: 224_000,
};

const render = (over: Partial<StoryRenderRow> = {}): StoryRenderRow => ({
	id: "r1",
	userId: "u1",
	trackId: "3135556",
	theme: "vinyl",
	startMs: 59_700,
	endMs: 68_000,
	status: "queued",
	progress: 0,
	storagePath: null,
	size: null,
	error: null,
	createdAt: new Date("2026-10-25T12:00:00Z"),
	updatedAt: new Date("2026-10-25T12:00:00Z"),
	readyAt: null,
	...over,
});

const post = (body: unknown) => POST(makeNextRequest({ method: "POST", body }));

beforeEach(() => {
	clearSession();
	afterMock.mockReset();
	vi.mocked(requestRender).mockReset();
	vi.mocked(runRender).mockReset();
});

describe("POST /api/v1/stories", () => {
	it("needs a signed-in user", async () => {
		expect((await post(valid)).status).toBe(401);
		expect(requestRender).not.toHaveBeenCalled();
	});

	it("creates a render, answers 202 and renders it after the response", async () => {
		setSessionUser("u1");
		vi.mocked(requestRender).mockResolvedValue({ kind: "created", render: render() });
		const res = await post(valid);
		expect(res.status).toBe(202);
		expect((await readJson<Body>(res))?.data).toMatchObject({ id: "r1", status: "queued", url: null });
		expect(afterMock).toHaveBeenCalledTimes(1);
		await afterMock.mock.calls[0][0]();
		expect(runRender).toHaveBeenCalledWith("r1");
	});

	it("passes the checked request: cleaned metadata, Deezer-only cover, the parsed range", async () => {
		setSessionUser("u1");
		vi.mocked(requestRender).mockResolvedValue({ kind: "created", render: render() });
		await post(valid);
		const [userId, input] = vi.mocked(requestRender).mock.calls[0];
		expect(userId).toBe("u1");
		expect(input).toMatchObject({ trackId: "3135556", theme: "vinyl", title: "Harder, Better", artist: "Daft Punk", coverUrl: null, trackDurationMs: 224_000, nextLineMs: 68_000 });
		expect(input.range).toMatchObject({ startMs: 59_700, endMs: 68_000 });
	});

	it("accepts a numeric track id and the song's last lines (nextLineMs null)", async () => {
		setSessionUser("u1");
		vi.mocked(requestRender).mockResolvedValue({ kind: "created", render: render() });
		// 0.3 s + 4 s after a lone last line is under 5 s: the song's last two lines.
		const res = await post({ ...valid, trackId: 3135556, lines: [{ timeMs: 200_000, text: "almost" }, { timeMs: 202_000, text: "end" }], nextLineMs: null });
		expect(res.status).toBe(202);
		expect(vi.mocked(requestRender).mock.calls[0][1]).toMatchObject({ trackId: "3135556", nextLineMs: null });
	});

	it("answers 200 with the same request's render, without rendering it again", async () => {
		setSessionUser("u1");
		vi.mocked(requestRender).mockResolvedValue({ kind: "reused", render: render({ status: "rendering", progress: 0.5 }) });
		const res = await post(valid);
		expect(res.status).toBe(200);
		expect((await readJson<Body>(res))?.data).toMatchObject({ status: "rendering", progress: 0.5 });
		expect(afterMock).not.toHaveBeenCalled();
	});

	it("answers 409 RENDER_IN_PROGRESS with the running render's id", async () => {
		setSessionUser("u1");
		vi.mocked(requestRender).mockResolvedValue({ kind: "busy", render: render({ id: "other" }) });
		const res = await post(valid);
		expect(res.status).toBe(409);
		expect(res.headers.get("x-story-render-id")).toBe("other");
		expect((await readJson<Body>(res))?.error.code).toBe("RENDER_IN_PROGRESS");
	});

	it("answers 429 DAILY_LIMIT", async () => {
		setSessionUser("u1");
		vi.mocked(requestRender).mockResolvedValue({ kind: "limit" });
		const res = await post(valid);
		expect(res.status).toBe(429);
		expect((await readJson<Body>(res))?.error.code).toBe("DAILY_LIMIT");
	});

	it.each([
		["no track id", { ...valid, trackId: undefined }, "MISSING_TRACK_ID"],
		["a non-Deezer track id", { ...valid, trackId: "../etc" }, "MISSING_TRACK_ID"],
		["an unknown theme", { ...valid, theme: "neon" }, "INVALID_THEME"],
		["no title", { ...valid, title: "" }, "MISSING_METADATA"],
		["an excerpt under 5 s", { ...valid, lines: [valid.lines[0]], nextLineMs: 62_000 }, "INVALID_RANGE"],
		["an excerpt over 60 s", { ...valid, nextLineMs: 125_000 }, "INVALID_RANGE"],
	])("answers 400 to %s", async (_n, body, code) => {
		setSessionUser("u1");
		const res = await post(body);
		expect(res.status).toBe(400);
		expect((await readJson<Body>(res))?.error.code).toBe(code);
		expect(requestRender).not.toHaveBeenCalled();
	});

	it("hides a database failure behind 500 INTERNAL_ERROR", async () => {
		setSessionUser("u1");
		vi.spyOn(console, "error").mockImplementation(() => {});
		vi.mocked(requestRender).mockRejectedValue(new Error("connection refused 10.0.0.3"));
		const res = await post(valid);
		expect(res.status).toBe(500);
		expect((await readJson<Body>(res))?.error.code).toBe("INTERNAL_ERROR");
	});
});
