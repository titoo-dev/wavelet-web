// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { prismaMock, resetPrismaMock } from "@/test/helpers/mockPrisma";

vi.mock("@/lib/prisma", () => ({ prisma: prismaMock }));

const { DeezerCtor, instances, loginResults } = vi.hoisted(() => {
	const instances: Array<{ loginViaArl: ReturnType<typeof vi.fn>; loggedIn: boolean }> = [];
	const loginResults: Array<boolean | Error> = [];
	const DeezerCtor = vi.fn(function () {
		const instance = {
			loggedIn: false,
			loginViaArl: vi.fn(async () => {
				const next = loginResults.length ? loginResults.shift()! : true;
				if (next instanceof Error) throw next;
				instance.loggedIn = next;
				return next;
			}),
		};
		instances.push(instance);
		return instance;
	});
	return { DeezerCtor, instances, loginResults };
});
vi.mock("@/lib/deezer", () => ({ Deezer: DeezerCtor }));

import { getGuestDz, getOrLoginUserDz, getUserDz, removeUserDz, setUserDz, GUEST_SESSION_TTL_MS } from "./server-state";
import type { Deezer } from "@/lib/deezer";

const g = globalThis as unknown as Record<string, unknown>;

beforeEach(() => {
	resetPrismaMock();
	DeezerCtor.mockClear();
	instances.length = 0;
	loginResults.length = 0;
	delete g.guestSession;
	delete g.guestLogin;
	removeUserDz("u1");
	vi.stubEnv("WAVELET_SERVICE_ARL", "service-arl");
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllEnvs();
});

describe("getGuestDz", () => {
	it("logs in once and reuses the session", async () => {
		const a = await getGuestDz();
		const b = await getGuestDz();
		expect(a).toBe(instances[0]);
		expect(b).toBe(a);
		expect(DeezerCtor).toHaveBeenCalledTimes(1);
		expect(instances[0].loginViaArl).toHaveBeenCalledWith("service-arl");
	});

	it("re-logs in after the TTL (was: guest session cached forever once logged in)", async () => {
		vi.useFakeTimers();
		const first = await getGuestDz();
		vi.advanceTimersByTime(GUEST_SESSION_TTL_MS + 1);
		const second = await getGuestDz();
		expect(DeezerCtor).toHaveBeenCalledTimes(2);
		expect(second).not.toBe(first);
		expect(second).toBe(instances[1]);
	});

	it("keeps serving the old session when the refresh fails", async () => {
		vi.useFakeTimers();
		const first = await getGuestDz();
		vi.advanceTimersByTime(GUEST_SESSION_TTL_MS + 1);
		loginResults.push(false);
		await expect(getGuestDz()).resolves.toBe(first);
	});

	it("single-flights concurrent cold logins", async () => {
		const [a, b, c] = await Promise.all([getGuestDz(), getGuestDz(), getGuestDz()]);
		expect(DeezerCtor).toHaveBeenCalledTimes(1);
		expect(a).toBe(b);
		expect(b).toBe(c);
	});

	it("returns null without a service ARL or when the login fails", async () => {
		vi.stubEnv("WAVELET_SERVICE_ARL", "");
		await expect(getGuestDz()).resolves.toBeNull();
		vi.stubEnv("WAVELET_SERVICE_ARL", "service-arl");
		loginResults.push(new Error("network down"));
		await expect(getGuestDz()).resolves.toBeNull();
	});
});

describe("getOrLoginUserDz", () => {
	it("returns the cached session without touching the database", async () => {
		const dz = { loggedIn: true } as unknown as Deezer;
		setUserDz("u1", dz);
		await expect(getOrLoginUserDz("u1")).resolves.toBe(dz);
		expect(prismaMock.deezerCredential.findUnique).not.toHaveBeenCalled();
	});

	it("restores with the stored child account through the shared single-flight path (was: separate login, child 0)", async () => {
		prismaMock.deezerCredential.findUnique.mockResolvedValue({ userId: "u1", arl: "stored-arl", childAccount: 1 });
		const [a, b] = await Promise.all([getOrLoginUserDz("u1"), getOrLoginUserDz("u1")]);
		expect(DeezerCtor).toHaveBeenCalledTimes(1);
		expect(instances[0].loginViaArl).toHaveBeenCalledWith("stored-arl", 1);
		expect(a).toBe(instances[0]);
		expect(b).toBe(a);
		expect(getUserDz("u1")).toBe(a);
	});

	it("returns null without a credential or when the login fails", async () => {
		prismaMock.deezerCredential.findUnique.mockResolvedValue(null);
		await expect(getOrLoginUserDz("u1")).resolves.toBeNull();
		prismaMock.deezerCredential.findUnique.mockResolvedValue({ userId: "u1", arl: "bad" });
		loginResults.push(false);
		await expect(getOrLoginUserDz("u1")).resolves.toBeNull();
		prismaMock.deezerCredential.findUnique.mockRejectedValue(new Error("db down"));
		await expect(getOrLoginUserDz("u1")).resolves.toBeNull();
	});
});
