// Server-side singleton state for the WaveletApp
// This module is only imported in API routes (server-side)

import type { Listener } from "@/lib/wavelet/types/listener";
import type { Deezer } from "@/lib/deezer";
import type { WaveletApp } from "@/lib/wavelet-app";

// ── Per-user Deezer session with TTL eviction ──

interface DzSession {
	dz: Deezer;
	lastAccess: number;
}

const SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes

const globalForWavelet = globalThis as unknown as {
	waveletApp: WaveletApp | null;
	sessionDZ: Map<string, DzSession>;
	guestSession?: { dz: Deezer; loggedInAt: number };
	guestLogin?: Promise<Deezer | null>;
	initialized: boolean;
};

/** Get a per-user Deezer session map (keyed by better-auth user ID) */
export function getSessionDZ(): Map<string, DzSession> {
	if (!globalForWavelet.sessionDZ) {
		globalForWavelet.sessionDZ = new Map();
	}
	return globalForWavelet.sessionDZ;
}

/** Retrieve the Deezer instance for a specific user, refreshing TTL */
export function getUserDz(userId: string): Deezer | null {
	const sessions = getSessionDZ();
	const entry = sessions.get(userId);
	if (!entry) return null;
	entry.lastAccess = Date.now();
	return entry.dz;
}

/** Store a Deezer instance for a specific user */
export function setUserDz(userId: string, dz: Deezer): void {
	const sessions = getSessionDZ();
	sessions.set(userId, { dz, lastAccess: Date.now() });
	evictStaleSessions();
}

/** Remove a Deezer session for a specific user */
export function removeUserDz(userId: string): void {
	getSessionDZ().delete(userId);
}

/**
 * Resolve a Deezer session for a specific user — uses the in-memory cache
 * if available, otherwise logs in with the user's stored ARL and child
 * account through the shared single-flight restore (src/lib/deezer-session).
 * Used by routes that act on behalf of a user (e.g. public share playback
 * falling back to progressive re-stream with the share creator's ARL).
 */
export async function getOrLoginUserDz(userId: string): Promise<Deezer | null> {
	const cached = getUserDz(userId);
	if (cached?.loggedIn) return cached;

	try {
		const { restoreUserDz } = await import("@/lib/deezer-session");
		const restored = await restoreUserDz(userId);
		return restored.status === "ok" ? restored.dz : null;
	} catch {
		return null;
	}
}

/** The guest session is re-logged in after this long (license / api tokens age out). */
export const GUEST_SESSION_TTL_MS = 30 * 60 * 1000;

/** Get or create a shared guest Deezer session (for browsing without auth) */
export async function getGuestDz(): Promise<Deezer | null> {
	const current = globalForWavelet.guestSession;
	if (current?.dz?.loggedIn && Date.now() - current.loggedInAt < GUEST_SESSION_TTL_MS) {
		return current.dz;
	}

	const serviceArl = process.env.WAVELET_SERVICE_ARL;
	if (!serviceArl) return null;

	// One login at a time, shared by every concurrent caller.
	if (!globalForWavelet.guestLogin) {
		globalForWavelet.guestLogin = loginGuest(serviceArl).finally(() => {
			globalForWavelet.guestLogin = undefined;
		});
	}
	const fresh = await globalForWavelet.guestLogin;
	// A failed refresh keeps serving the previous session rather than nothing.
	return fresh ?? (current?.dz?.loggedIn ? current.dz : null);
}

async function loginGuest(serviceArl: string): Promise<Deezer | null> {
	try {
		const { Deezer } = await import("@/lib/deezer");
		const dz = new Deezer();
		const loggedIn = await dz.loginViaArl(serviceArl);
		if (loggedIn) {
			globalForWavelet.guestSession = { dz, loggedInAt: Date.now() };
			return dz;
		}
	} catch {
		// Guest Deezer unavailable
	}
	return null;
}

function evictStaleSessions() {
	const sessions = getSessionDZ();
	const now = Date.now();
	for (const [userId, entry] of sessions) {
		if (now - entry.lastAccess > SESSION_TTL_MS) {
			sessions.delete(userId);
		}
	}
}

// ── WaveletApp singleton ──

let _waveletApp: WaveletApp | null = null;
let _initPromise: Promise<WaveletApp | null> | null = null;

export async function getWaveletApp(): Promise<WaveletApp | null> {
	if (_waveletApp) return _waveletApp;
	if (!_initPromise) {
		_initPromise = initializeWaveletApp().then((app) => {
			_waveletApp = app;
			return app;
		});
	}
	return _initPromise;
}

async function initializeWaveletApp() {
	// Dynamic import to avoid issues during build
	try {
		const { createConfigStore } = await import(
			"@/lib/wavelet/config-store/index"
		);
		const configStore = await createConfigStore();

		const { WaveletApp } = await import("@/lib/wavelet-app");
		const app = new WaveletApp(createListener(), configStore);
		await app.init(); // Must await before returning
		globalForWavelet.waveletApp = app;
		return app;
	} catch (e) {
		console.error("Failed to initialize WaveletApp:", e);
		_initPromise = null; // Allow retry on failure
		return null;
	}
}

function createListener(): Listener {
	// No-op listener: the WS broadcast server is gone. Progressive streaming
	// engine + library helpers don't need to broadcast anything; the legacy
	// queue path (still alive in wavelet-app.ts during the transition) just
	// drops its events on the floor here.
	return {
		send() {},
	};
}
