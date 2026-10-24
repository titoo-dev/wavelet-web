// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest";
import { prismaMock } from "@/test/helpers/mockPrisma";
import { authMock, setSessionUser, clearSession } from "@/test/helpers/mockAuth";
import { makeNextRequest, readJson } from "@/test/helpers/nextRequest";

vi.mock("@/lib/prisma", () => ({ prisma: prismaMock }));
vi.mock("@/lib/auth", () => ({ auth: authMock }));
vi.mock("@/lib/story/still", async (importOriginal) => {
	const real = await importOriginal<typeof import("@/lib/story/still")>();
	return { ...real, loadCover: vi.fn(async () => null), renderStill: vi.fn(real.renderStill) };
});

import { POST, resetStillLimiter } from "./route";
import { loadCover, renderStill } from "@/lib/story/still";

type ErrorBody = { error: { code: string; message: string } };

const valid = {
	theme: "palette",
	title: "  Get   Lucky ",
	artist: "Daft Punk",
	coverUrl: "https://cdn-images.dzcdn.net/images/cover/abc/250x250-000000-80-0-0.jpg",
	lines: [
		{ timeMs: 60_000, text: "Like the legend of the phoenix" },
		{ timeMs: 64_000, text: "All ends with beginnings" },
	],
	nextLineMs: 68_000,
	trackDurationMs: 248_000,
};

const post = (body: unknown) => POST(makeNextRequest({ method: "POST", body }));

beforeEach(() => {
	clearSession();
	resetStillLimiter();
	vi.mocked(loadCover).mockClear();
	vi.mocked(renderStill).mockClear();
});

describe("POST /api/v1/stories/stills", () => {
	it("needs a signed-in user", async () => {
		const res = await post(valid);
		expect(res.status).toBe(401);
		expect(renderStill).not.toHaveBeenCalled();
	});

	it("answers the Theme Still as a private JPEG", async () => {
		setSessionUser("u1");
		const res = await post(valid);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toBe("image/jpeg");
		expect(res.headers.get("cache-control")).toBe("private, max-age=3600");
		const bytes = new Uint8Array(await res.arrayBuffer());
		expect([bytes[0], bytes[1]]).toEqual([0xff, 0xd8]);
		expect(Number(res.headers.get("content-length"))).toBe(bytes.length);
	});

	it("draws the client's lines and cleaned metadata, with the cover from the sent URL", async () => {
		setSessionUser("u1");
		await post(valid);
		expect(loadCover).toHaveBeenCalledWith(valid.coverUrl);
		const req = vi.mocked(renderStill).mock.calls[0][0];
		expect(req).toMatchObject({ theme: "palette", title: "Get Lucky", artist: "Daft Punk" });
		expect(req.range).toMatchObject({ startMs: 59_700, endMs: 68_000 });
		expect(req.range.lines.map((l) => l.text)).toEqual(["Like the legend of the phoenix", "All ends with beginnings"]);
	});

	it.each([
		["an unknown theme", { ...valid, theme: "neon" }, "INVALID_THEME"],
		["no theme", { ...valid, theme: undefined }, "INVALID_THEME"],
		["a blank title", { ...valid, title: "  " }, "MISSING_METADATA"],
		["no artist", { ...valid, artist: undefined }, "MISSING_METADATA"],
		["an excerpt over 30 s", { ...valid, nextLineMs: 95_000 }, "INVALID_RANGE"],
		["lines going backwards", { ...valid, lines: [...valid.lines].reverse() }, "INVALID_RANGE"],
	])("answers 400 to %s", async (_name, body, code) => {
		setSessionUser("u1");
		const res = await post(body);
		expect(res.status).toBe(400);
		expect((await readJson<ErrorBody>(res))?.error.code).toBe(code);
		expect(renderStill).not.toHaveBeenCalled();
	});

	it("answers 400 INVALID_BODY to a body that is not a JSON object", async () => {
		setSessionUser("u1");
		const res = await post("[1,2]");
		expect((await readJson<ErrorBody>(res))?.error.code).toBe("INVALID_BODY");
	});

	it("limits each user to 60 a minute, with Retry-After", async () => {
		setSessionUser("u1");
		vi.mocked(renderStill).mockResolvedValue(Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
		for (let i = 0; i < 60; i++) expect((await post(valid)).status).toBe(200);
		const res = await post(valid);
		expect(res.status).toBe(429);
		expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
		setSessionUser("u2");
		expect((await post(valid)).status).toBe(200);
	});

	it("does not count refused requests against the limit", async () => {
		setSessionUser("u1");
		vi.mocked(renderStill).mockResolvedValue(Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
		for (let i = 0; i < 70; i++) await post({ ...valid, theme: "neon" });
		expect((await post(valid)).status).toBe(200);
	});

	it("hides internal errors behind 500 INTERNAL_ERROR", async () => {
		setSessionUser("u1");
		vi.mocked(renderStill).mockRejectedValueOnce(new Error("skia exploded"));
		const res = await post(valid);
		expect(res.status).toBe(500);
		expect((await readJson<ErrorBody>(res))?.error.code).toBe("INTERNAL_ERROR");
	});
});
