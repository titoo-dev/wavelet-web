import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { inspect } from "node:util";
import { prismaMock, resetPrismaMock } from "@/test/helpers/mockPrisma";
import {
	authMock,
	setSessionUser,
	clearSession,
	failSession,
} from "@/test/helpers/mockAuth";
import { makeNextRequest, readJson } from "@/test/helpers/nextRequest";
import { decryptSecret, encryptSecret } from "@/lib/secret-box";

// ── Mock setup ──

vi.mock("@/lib/prisma", () => ({ prisma: prismaMock }));
vi.mock("@/lib/auth", () => ({ auth: authMock }));

const { serverStateMock, DeezerCtor, deezerInstances, deezerLoginBehavior } =
	vi.hoisted(() => {
		const serverStateMock = {
			getWaveletApp: vi.fn(),
			getUserDz: vi.fn(),
			setUserDz: vi.fn(),
			getGuestDz: vi.fn(),
		};
		const deezerInstances: Array<{
			loginViaArl: ReturnType<typeof vi.fn>;
			loggedIn: boolean;
		}> = [];
		// Per-instance login behavior — set before invoking the helper to control
		// the next `new Deezer()` call. Default: succeed.
		const deezerLoginBehavior: {
			next: "ok" | "fail" | "throw";
		} = { next: "ok" };
		const DeezerCtor = vi.fn(function () {
			const behavior = deezerLoginBehavior.next;
			// reset to default after consuming
			deezerLoginBehavior.next = "ok";
			const loginViaArl = vi.fn(async (_arl: string) => {
				if (behavior === "throw") throw new Error("network down");
				return behavior === "ok";
			});
			const instance = { loginViaArl, loggedIn: false };
			deezerInstances.push(instance);
			return instance;
		});
		return { serverStateMock, DeezerCtor, deezerInstances, deezerLoginBehavior };
	});

vi.mock("@/lib/server-state", () => serverStateMock);
vi.mock("@/lib/deezer", () => ({ Deezer: DeezerCtor }));

import {
	ok,
	fail,
	requireUser,
	requireAdmin,
	adminEmails,
	requireDeezer,
	requireApp,
	requireUserAndApp,
	requireDeezerAndApp,
	getGuestOrUserDz,
	handleError,
	readJsonBody,
} from "./helpers";

beforeEach(() => {
	resetPrismaMock();
	clearSession();
	Object.values(serverStateMock).forEach((m) => m.mockReset());
	DeezerCtor.mockClear();
	deezerInstances.length = 0;
	deezerLoginBehavior.next = "ok";
});

afterEach(() => {
	vi.unstubAllEnvs();
});

// ────────────────────────────────────────────────────────────
// ok
// ────────────────────────────────────────────────────────────

describe("ok()", () => {
	it("returns 200 by default", async () => {
		const res = ok({ hello: "world" });
		expect(res.status).toBe(200);
	});

	it("wraps payload in { success: true, data }", async () => {
		const res = ok({ hello: "world" });
		const body = await readJson<{ success: boolean; data: { hello: string } }>(
			res
		);
		expect(body).toEqual({ success: true, data: { hello: "world" } });
	});

	it("emits Cache-Control: no-store", () => {
		const res = ok({ a: 1 });
		expect(res.headers.get("Cache-Control")).toBe("no-store");
	});

	it("honors a custom status code", async () => {
		const res = ok({ ok: true }, 201);
		expect(res.status).toBe(201);
		const body = await readJson<{ success: boolean; data: { ok: boolean } }>(
			res
		);
		expect(body?.data).toEqual({ ok: true });
	});

	it("supports null/empty data payloads", async () => {
		const res = ok(null);
		expect(res.status).toBe(200);
		const body = await readJson<{ success: boolean; data: null }>(res);
		expect(body).toEqual({ success: true, data: null });
	});
});

// ────────────────────────────────────────────────────────────
// fail
// ────────────────────────────────────────────────────────────

describe("fail()", () => {
	it("defaults to status 400", () => {
		const res = fail("BAD", "no good");
		expect(res.status).toBe(400);
	});

	it("wraps payload in { success: false, error: { code, message } }", async () => {
		const res = fail("BAD", "no good");
		const body = await readJson<{
			success: boolean;
			error: { code: string; message: string };
		}>(res);
		expect(body).toEqual({
			success: false,
			error: { code: "BAD", message: "no good" },
		});
	});

	it("honors custom status codes", () => {
		const res = fail("NOT_FOUND", "missing", 404);
		expect(res.status).toBe(404);
	});
});

// ────────────────────────────────────────────────────────────
// requireUser
// ────────────────────────────────────────────────────────────

describe("requireUser()", () => {
	it("returns userId + session when authenticated", async () => {
		setSessionUser("u1");
		const result = await requireUser(makeNextRequest());
		expect(result.error).toBeNull();
		expect(result.userId).toBe("u1");
		expect(result.session).toMatchObject({ user: { id: "u1" } });
	});

	it("returns 401 NOT_AUTHENTICATED when no session", async () => {
		const result = await requireUser(makeNextRequest());
		expect(result.error).toBeTruthy();
		expect(result.error!.status).toBe(401);
		const body = await readJson<{ error: { code: string } }>(result.error!);
		expect(body?.error.code).toBe("NOT_AUTHENTICATED");
	});

	it("returns 401 NOT_AUTHENTICATED when session has no user.id", async () => {
		// Session present but missing user.id
		authMock.api.getSession.mockResolvedValueOnce({} as never);
		const result = await requireUser(makeNextRequest());
		expect(result.error).toBeTruthy();
		expect(result.error!.status).toBe(401);
		const body = await readJson<{ error: { code: string } }>(result.error!);
		expect(body?.error.code).toBe("NOT_AUTHENTICATED");
	});

	it("returns 500 AUTH_ERROR when getSession throws", async () => {
		failSession();
		const result = await requireUser(makeNextRequest());
		expect(result.error).toBeTruthy();
		expect(result.error!.status).toBe(500);
		const body = await readJson<{ error: { code: string } }>(result.error!);
		expect(body?.error.code).toBe("AUTH_ERROR");
	});
});

// ────────────────────────────────────────────────────────────
// adminEmails / requireAdmin
// ────────────────────────────────────────────────────────────

describe("adminEmails()", () => {
	it("parses a comma-separated, case-insensitive list and drops blanks", () => {
		expect(adminEmails({ WAVELET_ADMIN_EMAILS: " A@x.io, ,b@Y.io ," })).toEqual(["a@x.io", "b@y.io"]);
	});

	it("is empty when the variable is unset or blank", () => {
		expect(adminEmails({})).toEqual([]);
		expect(adminEmails({ WAVELET_ADMIN_EMAILS: "  " })).toEqual([]);
	});
});

describe("requireAdmin()", () => {
	const signIn = (email?: string) =>
		authMock.api.getSession.mockResolvedValue({ user: { id: "u1", email } } as never);

	it("passes any signed-in user when WAVELET_ADMIN_EMAILS is unset", async () => {
		vi.stubEnv("WAVELET_ADMIN_EMAILS", "");
		signIn("someone@example.com");
		const result = await requireAdmin(makeNextRequest());
		expect(result.error).toBeNull();
		expect(result.userId).toBe("u1");
	});

	it("passes a listed admin whatever the case", async () => {
		vi.stubEnv("WAVELET_ADMIN_EMAILS", "Admin@Example.com");
		signIn("ADMIN@example.COM");
		const result = await requireAdmin(makeNextRequest());
		expect(result.error).toBeNull();
	});

	it("returns 403 FORBIDDEN for a signed-in user who is not listed (was: every signed-in user could change server-wide settings)", async () => {
		vi.stubEnv("WAVELET_ADMIN_EMAILS", "admin@example.com");
		signIn("someone@example.com");
		const result = await requireAdmin(makeNextRequest());
		expect(result.error!.status).toBe(403);
		const body = await readJson<{ error: { code: string } }>(result.error!);
		expect(body?.error.code).toBe("FORBIDDEN");
	});

	it("passes requireUser's 401 / 500 through unchanged", async () => {
		vi.stubEnv("WAVELET_ADMIN_EMAILS", "admin@example.com");
		expect((await requireAdmin(makeNextRequest())).error!.status).toBe(401);
		failSession();
		expect((await requireAdmin(makeNextRequest())).error!.status).toBe(500);
	});
});

// ────────────────────────────────────────────────────────────
// requireDeezer
// ────────────────────────────────────────────────────────────

describe("requireDeezer()", () => {
	it("propagates the 401 from requireUser when not authenticated", async () => {
		const result = await requireDeezer(makeNextRequest());
		expect(result.error).toBeTruthy();
		expect(result.error!.status).toBe(401);
		const body = await readJson<{ error: { code: string } }>(result.error!);
		expect(body?.error.code).toBe("NOT_AUTHENTICATED");
	});

	it("reuses the cached dz when loggedIn=true (no DB lookup)", async () => {
		setSessionUser("u1");
		const cachedDz = { loggedIn: true };
		serverStateMock.getUserDz.mockReturnValue(cachedDz);

		const result = await requireDeezer(makeNextRequest());
		expect(result.error).toBeNull();
		expect(result.dz).toBe(cachedDz);
		expect(result.userId).toBe("u1");
		expect(prismaMock.deezerCredential.findUnique).not.toHaveBeenCalled();
		expect(serverStateMock.setUserDz).not.toHaveBeenCalled();
		expect(DeezerCtor).not.toHaveBeenCalled();
	});

	it("loads ARL from DB and logs in successfully when no cached dz", async () => {
		setSessionUser("u1");
		serverStateMock.getUserDz.mockReturnValue(null);
		prismaMock.deezerCredential.findUnique.mockResolvedValue({
			userId: "u1",
			arl: "stored-arl",
		});

		const result = await requireDeezer(makeNextRequest());

		expect(result.error).toBeNull();
		expect(result.userId).toBe("u1");
		expect(DeezerCtor).toHaveBeenCalledTimes(1);
		// Contract change (S14): the stored child account is passed on every restore.
		expect(deezerInstances[0].loginViaArl).toHaveBeenCalledWith("stored-arl", 0);
		expect(serverStateMock.setUserDz).toHaveBeenCalledWith(
			"u1",
			deezerInstances[0]
		);
		expect(result.dz).toBe(deezerInstances[0]);
	});

	it("restores the saved child account (was: every restore logged in as child 0)", async () => {
		setSessionUser("u1");
		serverStateMock.getUserDz.mockReturnValue(null);
		prismaMock.deezerCredential.findUnique.mockResolvedValue({
			userId: "u1",
			arl: "stored-arl",
			childAccount: 2,
		});

		const result = await requireDeezer(makeNextRequest());
		expect(result.error).toBeNull();
		expect(deezerInstances[0].loginViaArl).toHaveBeenCalledWith("stored-arl", 2);
	});

	it("logs in once for concurrent cold requests (was: N concurrent requests → N ARL logins)", async () => {
		setSessionUser("u1");
		serverStateMock.getUserDz.mockReturnValue(null);
		prismaMock.deezerCredential.findUnique.mockResolvedValue({
			userId: "u1",
			arl: "stored-arl",
		});

		const results = await Promise.all([
			requireDeezer(makeNextRequest()),
			requireDeezer(makeNextRequest()),
			getGuestOrUserDz(makeNextRequest()),
		]);
		expect(DeezerCtor).toHaveBeenCalledTimes(1);
		expect(prismaMock.deezerCredential.findUnique).toHaveBeenCalledTimes(1);
		for (const r of results) expect(r.dz).toBe(deezerInstances[0]);

		// Once settled, a later cold request logs in again (nothing is pinned).
		await requireDeezer(makeNextRequest());
		expect(DeezerCtor).toHaveBeenCalledTimes(2);
	});

	it("decrypts an encrypted stored ARL before logging in", async () => {
		vi.stubEnv("BETTER_AUTH_SECRET", "test-secret");
		setSessionUser("u1");
		serverStateMock.getUserDz.mockReturnValue(null);
		prismaMock.deezerCredential.findUnique.mockResolvedValue({
			userId: "u1",
			arl: encryptSecret("real-arl"),
			childAccount: 0,
		});

		const result = await requireDeezer(makeNextRequest());
		expect(result.error).toBeNull();
		expect(deezerInstances[0].loginViaArl).toHaveBeenCalledWith("real-arl", 0);
		expect(prismaMock.deezerCredential.updateMany).not.toHaveBeenCalled();
	});

	it("re-encrypts a legacy plaintext ARL after it logs in (was: ARL stored in plaintext)", async () => {
		vi.stubEnv("BETTER_AUTH_SECRET", "test-secret");
		setSessionUser("u1");
		serverStateMock.getUserDz.mockReturnValue(null);
		prismaMock.deezerCredential.findUnique.mockResolvedValue({
			userId: "u1",
			arl: "legacy-plain",
		});

		await requireDeezer(makeNextRequest());
		expect(prismaMock.deezerCredential.updateMany).toHaveBeenCalledTimes(1);
		const args = prismaMock.deezerCredential.updateMany.mock.calls[0][0];
		expect(args.where).toEqual({ userId: "u1", arl: "legacy-plain" });
		expect(args.data.arl).toMatch(/^enc:v1:/);
		expect(decryptSecret(args.data.arl)).toBe("legacy-plain");
	});

	it("does not re-encrypt when Deezer refuses the legacy ARL", async () => {
		vi.stubEnv("BETTER_AUTH_SECRET", "test-secret");
		setSessionUser("u1");
		serverStateMock.getUserDz.mockReturnValue(null);
		prismaMock.deezerCredential.findUnique.mockResolvedValue({ userId: "u1", arl: "legacy-plain" });
		deezerLoginBehavior.next = "fail";

		await requireDeezer(makeNextRequest());
		expect(prismaMock.deezerCredential.updateMany).not.toHaveBeenCalled();
	});

	it("still logs in when re-encryption fails", async () => {
		vi.stubEnv("BETTER_AUTH_SECRET", "test-secret");
		setSessionUser("u1");
		serverStateMock.getUserDz.mockReturnValue(null);
		prismaMock.deezerCredential.findUnique.mockResolvedValue({ userId: "u1", arl: "legacy-plain" });
		prismaMock.deezerCredential.updateMany.mockRejectedValue(new Error("db down"));
		vi.spyOn(console, "warn").mockImplementation(() => {});

		const result = await requireDeezer(makeNextRequest());
		expect(result.error).toBeNull();
		expect(result.dz).toBe(deezerInstances[0]);
	});

	it("returns 401 DEEZER_LOGIN_FAILED, without crashing, when the stored ARL cannot be decrypted", async () => {
		vi.stubEnv("BETTER_AUTH_SECRET", "test-secret");
		vi.spyOn(console, "warn").mockImplementation(() => {});
		setSessionUser("u1");
		serverStateMock.getUserDz.mockReturnValue(null);
		prismaMock.deezerCredential.findUnique.mockResolvedValue({
			userId: "u1",
			arl: "enc:v1:AAAAAAAAAAAAAAAA:AAAAAAAAAAAAAAAAAAAAAA==:AAAA",
		});

		const result = await requireDeezer(makeNextRequest());
		expect(result.error!.status).toBe(401);
		const body = await readJson<{ error: { code: string } }>(result.error!);
		expect(body?.error.code).toBe("DEEZER_LOGIN_FAILED");
		expect(DeezerCtor).not.toHaveBeenCalled();
	});

	it("keeps a session that another request stored while this one was logging in", async () => {
		setSessionUser("u1");
		const fresh = { loggedIn: true, id: "fresh" };
		serverStateMock.getUserDz.mockReturnValueOnce(null).mockReturnValue(fresh);
		prismaMock.deezerCredential.findUnique.mockResolvedValue({ userId: "u1", arl: "stored-arl" });

		const result = await requireDeezer(makeNextRequest());
		expect(result.dz).toBe(fresh);
		expect(serverStateMock.setUserDz).not.toHaveBeenCalled();
	});

	it("re-logs in when cached dz exists but loggedIn=false", async () => {
		setSessionUser("u1");
		serverStateMock.getUserDz.mockReturnValue({ loggedIn: false });
		prismaMock.deezerCredential.findUnique.mockResolvedValue({
			userId: "u1",
			arl: "stored-arl",
		});

		const result = await requireDeezer(makeNextRequest());
		expect(result.error).toBeNull();
		expect(DeezerCtor).toHaveBeenCalledTimes(1);
		expect(serverStateMock.setUserDz).toHaveBeenCalled();
	});

	it("returns 403 NO_DEEZER_ARL when no credential is stored", async () => {
		setSessionUser("u1");
		serverStateMock.getUserDz.mockReturnValue(null);
		prismaMock.deezerCredential.findUnique.mockResolvedValue(null);

		const result = await requireDeezer(makeNextRequest());
		expect(result.error).toBeTruthy();
		expect(result.error!.status).toBe(403);
		const body = await readJson<{ error: { code: string } }>(result.error!);
		expect(body?.error.code).toBe("NO_DEEZER_ARL");
		expect(DeezerCtor).not.toHaveBeenCalled();
	});

	it("returns 401 DEEZER_LOGIN_FAILED when loginViaArl returns false", async () => {
		setSessionUser("u1");
		serverStateMock.getUserDz.mockReturnValue(null);
		prismaMock.deezerCredential.findUnique.mockResolvedValue({
			userId: "u1",
			arl: "bad-arl",
		});
		deezerLoginBehavior.next = "fail";

		const result = await requireDeezer(makeNextRequest());
		expect(result.error).toBeTruthy();
		expect(result.error!.status).toBe(401);
		const body = await readJson<{ error: { code: string } }>(result.error!);
		expect(body?.error.code).toBe("DEEZER_LOGIN_FAILED");
		expect(serverStateMock.setUserDz).not.toHaveBeenCalled();
	});

	it("returns 500 DEEZER_ERROR when prisma throws", async () => {
		setSessionUser("u1");
		serverStateMock.getUserDz.mockReturnValue(null);
		prismaMock.deezerCredential.findUnique.mockRejectedValue(
			new Error("db down")
		);

		const result = await requireDeezer(makeNextRequest());
		expect(result.error).toBeTruthy();
		expect(result.error!.status).toBe(500);
		const body = await readJson<{ error: { code: string } }>(result.error!);
		expect(body?.error.code).toBe("DEEZER_ERROR");
	});

	it("returns 500 DEEZER_ERROR when loginViaArl throws", async () => {
		setSessionUser("u1");
		serverStateMock.getUserDz.mockReturnValue(null);
		prismaMock.deezerCredential.findUnique.mockResolvedValue({
			userId: "u1",
			arl: "boom",
		});
		deezerLoginBehavior.next = "throw";

		const result = await requireDeezer(makeNextRequest());
		expect(result.error).toBeTruthy();
		expect(result.error!.status).toBe(500);
		const body = await readJson<{ error: { code: string } }>(result.error!);
		expect(body?.error.code).toBe("DEEZER_ERROR");
	});
});

// ────────────────────────────────────────────────────────────
// requireApp
// ────────────────────────────────────────────────────────────

describe("requireApp()", () => {
	it("returns the app when initialized", async () => {
		const fakeApp = { id: "app" };
		serverStateMock.getWaveletApp.mockResolvedValue(fakeApp);
		const result = await requireApp();
		expect(result.error).toBeNull();
		expect(result.app).toBe(fakeApp);
	});

	it("returns 500 APP_NOT_INITIALIZED when app is null", async () => {
		serverStateMock.getWaveletApp.mockResolvedValue(null);
		const result = await requireApp();
		expect(result.error).toBeTruthy();
		expect(result.error!.status).toBe(500);
		const body = await readJson<{ error: { code: string } }>(result.error!);
		expect(body?.error.code).toBe("APP_NOT_INITIALIZED");
	});
});

// ────────────────────────────────────────────────────────────
// requireUserAndApp
// ────────────────────────────────────────────────────────────

describe("requireUserAndApp()", () => {
	it("returns userId + app on the happy path", async () => {
		setSessionUser("u1");
		const fakeApp = { id: "app" };
		serverStateMock.getWaveletApp.mockResolvedValue(fakeApp);

		const result = await requireUserAndApp(makeNextRequest());
		expect(result.error).toBeNull();
		expect(result.userId).toBe("u1");
		expect(result.app).toBe(fakeApp);
	});

	it("returns the auth error when not authenticated (does not call getWaveletApp)", async () => {
		const result = await requireUserAndApp(makeNextRequest());
		expect(result.error).toBeTruthy();
		expect(result.error!.status).toBe(401);
		const body = await readJson<{ error: { code: string } }>(result.error!);
		expect(body?.error.code).toBe("NOT_AUTHENTICATED");
		expect(serverStateMock.getWaveletApp).not.toHaveBeenCalled();
	});

	it("returns 500 APP_NOT_INITIALIZED when authed but app is null", async () => {
		setSessionUser("u1");
		serverStateMock.getWaveletApp.mockResolvedValue(null);

		const result = await requireUserAndApp(makeNextRequest());
		expect(result.error).toBeTruthy();
		expect(result.error!.status).toBe(500);
		const body = await readJson<{ error: { code: string } }>(result.error!);
		expect(body?.error.code).toBe("APP_NOT_INITIALIZED");
	});
});

// ────────────────────────────────────────────────────────────
// requireDeezerAndApp
// ────────────────────────────────────────────────────────────

describe("requireDeezerAndApp()", () => {
	it("returns userId + dz + app on the happy path (cached dz)", async () => {
		setSessionUser("u1");
		const cachedDz = { loggedIn: true };
		const fakeApp = { id: "app" };
		serverStateMock.getUserDz.mockReturnValue(cachedDz);
		serverStateMock.getWaveletApp.mockResolvedValue(fakeApp);

		const result = await requireDeezerAndApp(makeNextRequest());
		expect(result.error).toBeNull();
		expect(result.userId).toBe("u1");
		expect(result.dz).toBe(cachedDz);
		expect(result.app).toBe(fakeApp);
	});

	it("propagates the Deezer error and skips getWaveletApp", async () => {
		setSessionUser("u1");
		serverStateMock.getUserDz.mockReturnValue(null);
		prismaMock.deezerCredential.findUnique.mockResolvedValue(null);

		const result = await requireDeezerAndApp(makeNextRequest());
		expect(result.error).toBeTruthy();
		expect(result.error!.status).toBe(403);
		const body = await readJson<{ error: { code: string } }>(result.error!);
		expect(body?.error.code).toBe("NO_DEEZER_ARL");
		expect(serverStateMock.getWaveletApp).not.toHaveBeenCalled();
	});

	it("returns 500 APP_NOT_INITIALIZED when Deezer ok but app is null", async () => {
		setSessionUser("u1");
		serverStateMock.getUserDz.mockReturnValue({ loggedIn: true });
		serverStateMock.getWaveletApp.mockResolvedValue(null);

		const result = await requireDeezerAndApp(makeNextRequest());
		expect(result.error).toBeTruthy();
		expect(result.error!.status).toBe(500);
		const body = await readJson<{ error: { code: string } }>(result.error!);
		expect(body?.error.code).toBe("APP_NOT_INITIALIZED");
	});

	it("propagates the auth error before touching Deezer or app", async () => {
		const result = await requireDeezerAndApp(makeNextRequest());
		expect(result.error).toBeTruthy();
		expect(result.error!.status).toBe(401);
		expect(prismaMock.deezerCredential.findUnique).not.toHaveBeenCalled();
		expect(serverStateMock.getWaveletApp).not.toHaveBeenCalled();
	});
});

// ────────────────────────────────────────────────────────────
// getGuestOrUserDz
// ────────────────────────────────────────────────────────────

describe("getGuestOrUserDz()", () => {
	it("returns the cached user dz when authed and loggedIn", async () => {
		setSessionUser("u1");
		const cachedDz = { loggedIn: true };
		serverStateMock.getUserDz.mockReturnValue(cachedDz);

		const result = await getGuestOrUserDz(makeNextRequest());
		expect(result.dz).toBe(cachedDz);
		expect(result.userId).toBe("u1");
		expect(serverStateMock.getGuestDz).not.toHaveBeenCalled();
		expect(prismaMock.deezerCredential.findUnique).not.toHaveBeenCalled();
	});

	it("restores from stored ARL and caches it when authed but no in-memory dz", async () => {
		setSessionUser("u1");
		serverStateMock.getUserDz.mockReturnValue(null);
		prismaMock.deezerCredential.findUnique.mockResolvedValue({
			userId: "u1",
			arl: "stored-arl",
		});

		const result = await getGuestOrUserDz(makeNextRequest());
		expect(result.userId).toBe("u1");
		expect(result.dz).toBe(deezerInstances[0]);
		// Contract change (S14): the stored child account is passed on every restore.
		expect(deezerInstances[0].loginViaArl).toHaveBeenCalledWith("stored-arl", 0);
		expect(serverStateMock.setUserDz).toHaveBeenCalledWith(
			"u1",
			deezerInstances[0]
		);
		expect(serverStateMock.getGuestDz).not.toHaveBeenCalled();
	});

	it("falls back to guest when authed user has no stored ARL", async () => {
		setSessionUser("u1");
		serverStateMock.getUserDz.mockReturnValue(null);
		prismaMock.deezerCredential.findUnique.mockResolvedValue(null);
		const guestDz = { id: "guest" };
		serverStateMock.getGuestDz.mockResolvedValue(guestDz);

		const result = await getGuestOrUserDz(makeNextRequest());
		expect(result.dz).toBe(guestDz);
		expect(result.userId).toBeNull();
	});

	it("falls back to guest when authed user's stored ARL fails to log in", async () => {
		setSessionUser("u1");
		serverStateMock.getUserDz.mockReturnValue(null);
		prismaMock.deezerCredential.findUnique.mockResolvedValue({
			userId: "u1",
			arl: "bad-arl",
		});
		deezerLoginBehavior.next = "fail";
		const guestDz = { id: "guest" };
		serverStateMock.getGuestDz.mockResolvedValue(guestDz);

		const result = await getGuestOrUserDz(makeNextRequest());
		expect(result.dz).toBe(guestDz);
		expect(result.userId).toBeNull();
		expect(serverStateMock.setUserDz).not.toHaveBeenCalled();
	});

	it("falls back to guest when getSession throws", async () => {
		failSession();
		const guestDz = { id: "guest" };
		serverStateMock.getGuestDz.mockResolvedValue(guestDz);

		const result = await getGuestOrUserDz(makeNextRequest());
		expect(result.dz).toBe(guestDz);
		expect(result.userId).toBeNull();
	});

	it("returns guest when not authenticated at all", async () => {
		const guestDz = { id: "guest" };
		serverStateMock.getGuestDz.mockResolvedValue(guestDz);

		const result = await getGuestOrUserDz(makeNextRequest());
		expect(result.dz).toBe(guestDz);
		expect(result.userId).toBeNull();
		expect(prismaMock.deezerCredential.findUnique).not.toHaveBeenCalled();
	});

	it("returns { dz: null, userId: null } when both user-dz and guest fail", async () => {
		serverStateMock.getGuestDz.mockResolvedValue(null);
		const result = await getGuestOrUserDz(makeNextRequest());
		expect(result.dz).toBeNull();
		expect(result.userId).toBeNull();
	});
});

// ────────────────────────────────────────────────────────────
// handleError
// ────────────────────────────────────────────────────────────

describe("handleError()", () => {
	// C8: a 500 never carries the internal error text (Prisma / Deezer / R2
	// messages can name tables, hosts or tokens); the detail is logged.
	const GENERIC = { code: "INTERNAL_ERROR", message: "An unexpected error occurred." };

	it("answers a generic INTERNAL_ERROR/500 and logs the detail server-side (was: the raw e.message was sent to the client)", async () => {
		const logged = vi.spyOn(console, "error").mockImplementation(() => {});
		const err = new Error("connect ECONNREFUSED db.internal:5432");
		const res = handleError(err);
		expect(res.status).toBe(500);
		const body = await readJson<{ error: { code: string; message: string } }>(
			res
		);
		expect(body?.error).toEqual(GENERIC);
		expect(JSON.stringify(body)).not.toContain("ECONNREFUSED");
		expect(String(logged.mock.calls[0])).toContain("ECONNREFUSED db.internal:5432");
	});

	it("logs name, message and stack only — never a got error's request options or URL query", async () => {
		const logged = vi.spyOn(console, "error").mockImplementation(() => {});
		const gotError = Object.assign(
			new Error("Request failed with status code 500: GET https://api.deezer.com/user/me?access_token=SECRET-ACCESS"),
			{ name: "HTTPError", options: { json: { license_token: "LT-SECRET" }, cookieJar: { arl: "ARL-SECRET" } } }
		);
		handleError(new Error("wrapped", { cause: gotError }));
		const printed = logged.mock.calls.map((args) => args.map((a) => inspect(a, { depth: 10 })).join(" ")).join("\n");
		expect(printed).toContain("wrapped");
		expect(printed).toContain("HTTPError");
		for (const secret of ["SECRET-ACCESS", "LT-SECRET", "ARL-SECRET"]) expect(printed).not.toContain(secret);
	});

	it("uses the same generic message for non-Error values", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const res = handleError("string oops");
		expect(res.status).toBe(500);
		const body = await readJson<{ error: { code: string; message: string } }>(
			res
		);
		expect(body?.error).toEqual(GENERIC);
	});

	it("uses the same generic message for null/undefined", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const res = handleError(null);
		const body = await readJson<{ error: { message: string } }>(res);
		expect(body?.error.message).toBe(GENERIC.message);
	});

	it("does not leak subclassed Error messages either (was: preserved them)", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		class MyErr extends Error {}
		const res = handleError(new MyErr("subclass"));
		const body = await readJson<{ error: { message: string } }>(res);
		expect(body?.error.message).toBe(GENERIC.message);
	});
});

describe("readJsonBody", () => {
	const req = (body: string) => new Request("http://localhost/x", { method: "POST", body, headers: { "Content-Type": "application/json" } });

	it("returns the parsed object", async () => {
		const r = await readJsonBody(req('{"arl":"a"}'));
		expect(r.error).toBeNull();
		expect(r.body).toEqual({ arl: "a" });
	});

	it.each([["{not json"], [""], ["[1,2]"], ["null"], ["\"text\""]])("answers 400 INVALID_BODY for %j (was: 500 from the JSON parser)", async (raw) => {
		const r = await readJsonBody(req(raw));
		expect(r.body).toBeNull();
		expect(r.error?.status).toBe(400);
		expect((await readJson<{ error: { code: string } }>(r.error!))?.error.code).toBe("INVALID_BODY");
	});
});
