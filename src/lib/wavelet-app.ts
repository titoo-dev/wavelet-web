// Server-side app singleton — holds shared settings, the storage provider,
// and the cross-user download lock map used by the progressive streaming
// engine. The legacy queue (addToQueue / startQueue) was removed in favor
// of the progressive streaming + library-save model.

import type { Listener } from "@/lib/wavelet/types/listener";
import type { Settings } from "@/lib/wavelet/types/Settings";
import type { ConfigStore } from "@/lib/wavelet/config-store/ConfigStore";
import type { StorageProvider } from "@/lib/wavelet/storage/StorageProvider";

type WaveletModule = typeof import("@/lib/wavelet");

let loadSettings: WaveletModule["loadSettings"] | undefined;
let saveSettingsFn: WaveletModule["saveSettings"] | undefined;
let DEFAULT_SETTINGS: WaveletModule["DEFAULT_SETTINGS"] | undefined;
let createStorageProvider: WaveletModule["createStorageProvider"] | undefined;
let _initialized = false;

async function ensureImports() {
	if (_initialized) return;
	try {
		const wavelet = await import("@/lib/wavelet");
		loadSettings = wavelet.loadSettings;
		saveSettingsFn = wavelet.saveSettings;
		DEFAULT_SETTINGS = wavelet.DEFAULT_SETTINGS;
		createStorageProvider = wavelet.createStorageProvider;
		_initialized = true;
	} catch (e) {
		console.error("Failed to import wavelet modules:", e);
	}
}

/**
 * How long a download lock may be held. Holders release in a `finally`, but
 * an invocation killed at maxDuration (300s on stream-progressive) never
 * gets there — without a TTL its lock would block that track on this
 * instance for good.
 */
export const DOWNLOAD_LOCK_TTL_MS = 330_000;

/**
 * How long a same-instance follower waits for the holder to open its stream
 * (gw + URL + CDN headers) before streaming live itself. It never waits for
 * the holder's persist.
 */
export const FOLLOW_WAIT_MS = 20_000;

interface DownloadLock {
	done: Promise<void>;
	acquiredAt: number;
	/** What the holder published for followers (its in-progress spool); null once released without one. */
	shared: Promise<unknown>;
}

export class WaveletApp {
	deezerAvailable?: "yes" | "no" | "no-network";
	settings: Settings;
	configStore: ConfigStore;
	storageProvider: StorageProvider | null;
	listener: Listener;

	/** Lock map: "trackId_bitrate" → Promise that resolves when a fetch
	 *  completes. Prevents concurrent progressive downloads of the same track. */
	private _downloadLocks: Map<string, DownloadLock> = new Map();

	/** When `settings` was last read from the config store (see freshSettings). */
	private _settingsLoadedAt = 0;

	constructor(listener: Listener, configStore: ConfigStore) {
		this.listener = listener;
		this.settings = {} as Settings;
		this.configStore = configStore;
		this.storageProvider = null;
	}

	async init() {
		await ensureImports();
		if (loadSettings) {
			this.settings = await loadSettings(this.configStore);
			this._settingsLoadedAt = Date.now();
		}
		if (createStorageProvider) {
			this.storageProvider = createStorageProvider();
		}
	}

	/**
	 * Settings no older than `maxAgeMs`. Each Vercel instance keeps its own
	 * WaveletApp, so a change saved on one instance (e.g. the server-wide
	 * streaming quality) only reaches the others by re-reading the config store.
	 */
	async freshSettings(maxAgeMs = 30_000): Promise<Settings> {
		if (loadSettings && Date.now() - this._settingsLoadedAt > maxAgeMs) {
			this.settings = await loadSettings(this.configStore);
			this._settingsLoadedAt = Date.now();
		}
		return this.settings;
	}

	/**
	 * Whether Deezer serves this deployment's region. "yes" / "no" are cached
	 * for the instance's lifetime; a network failure is not, so one outage
	 * doesn't report "no-network" until the instance is recycled. The request
	 * follows the Deezer timeout policy (S5) instead of hanging.
	 */
	async isDeezerAvailable(): Promise<"yes" | "no" | "no-network"> {
		if (this.deezerAvailable) return this.deezerAvailable;
		try {
			const got = (await import("got")).default;
			const { DEEZER_REQUEST_OPTIONS, DEEZER_USER_AGENT } = await import("@/lib/deezer/http");
			const response = await got.get("https://www.deezer.com/", {
				...DEEZER_REQUEST_OPTIONS,
				headers: {
					"User-Agent": DEEZER_USER_AGENT,
					Cookie:
						"dz_lang=en; Domain=deezer.com; Path=/; Secure; hostOnly=false;",
				},
			});
			const title = (
				response.body.match(/<title[^>]*>([^<]+)<\/title>/)?.[1] || ""
			).trim();
			this.deezerAvailable =
				title !== "Deezer will soon be available in your country." ? "yes" : "no";
			return this.deezerAvailable;
		} catch {
			return "no-network";
		}
	}

	getSettings() {
		return {
			settings: this.settings,
			defaultSettings: DEFAULT_SETTINGS,
		};
	}

	async saveSettings(newSettings: Settings) {
		if (saveSettingsFn) {
			await saveSettingsFn(newSettings, this.configStore);
		}
		this.settings = newSettings;
		this._settingsLoadedAt = Date.now();
		if (createStorageProvider) {
			this.storageProvider = createStorageProvider();
		}
	}

	/** Acquire a per-track download lock. Returns a release function plus
	 *  a flag indicating whether another fetch is already in progress.
	 *  C4: the holder `publish`es its in-progress stream once open; a
	 *  follower (`alreadyInProgress`) `follow`s it right away instead of
	 *  waiting for the persist to finish. */
	acquireDownloadLock(
		trackId: string,
		bitrate: number
	): {
		alreadyInProgress: boolean;
		waitForExisting: () => Promise<void>;
		/** Follower: the holder's published value, or null (released without one / not within FOLLOW_WAIT_MS). */
		follow: <T = unknown>(timeoutMs?: number) => Promise<T | null>;
		/** Holder: hand the in-progress stream to followers (first call wins). */
		publish: (value: unknown) => void;
		release: () => void;
	} {
		const lockKey = `${trackId}_${bitrate}`;
		const now = Date.now();
		const existing = this._downloadLocks.get(lockKey);
		if (existing && now - existing.acquiredAt < DOWNLOAD_LOCK_TTL_MS) {
			const remaining = DOWNLOAD_LOCK_TTL_MS - (now - existing.acquiredAt);
			return {
				alreadyInProgress: true,
				// Never outlive the holder's TTL, even if it never releases.
				waitForExisting: () =>
					new Promise<void>((resolve) => {
						const timer = setTimeout(resolve, remaining);
						void existing.done.then(() => {
							clearTimeout(timer);
							resolve();
						});
					}),
				follow: <T,>(timeoutMs = FOLLOW_WAIT_MS) =>
					new Promise<T | null>((resolve) => {
						const timer = setTimeout(() => resolve(null), Math.min(timeoutMs, remaining));
						void existing.shared.then((value) => {
							clearTimeout(timer);
							resolve((value ?? null) as T | null);
						});
					}),
				publish: () => {},
				release: () => {},
			};
		}
		let releaseFn: () => void;
		let shareFn: (value: unknown) => void;
		const lock: DownloadLock = {
			done: new Promise<void>((resolve) => {
				releaseFn = resolve;
			}),
			shared: new Promise<unknown>((resolve) => {
				shareFn = resolve;
			}),
			acquiredAt: now,
		};
		this._downloadLocks.set(lockKey, lock);
		return {
			alreadyInProgress: false,
			waitForExisting: () => Promise.resolve(),
			follow: () => Promise.resolve(null),
			publish: (value) => shareFn(value),
			release: () => {
				// A stale holder may release after its lock was taken over.
				if (this._downloadLocks.get(lockKey) === lock) {
					this._downloadLocks.delete(lockKey);
				}
				shareFn(null); // no-op when already published
				releaseFn();
			},
		};
	}
}
