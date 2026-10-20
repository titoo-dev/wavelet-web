import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act, waitFor } from "@testing-library/react";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), dismiss: vi.fn() }) }));
vi.mock("@/lib/audio-cache", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/audio-cache")>()),
	getCachedBlobUrl: vi.fn(async () => null),
	prefetchTrack: vi.fn(async () => false),
	removeCached: vi.fn(async () => {}),
}));

import { toast } from "sonner";
import { AudioEngine } from "./AudioEngine";
import { usePlayerStore, type PlayerTrack } from "@/stores/usePlayerStore";
import { usePreviewStore } from "@/stores/usePreviewStore";
import { useSyncStore } from "@/lib/playback-sync/useSyncStore";
import { setRemoteSender } from "@/lib/playback-sync/remote";
import { getCachedBlobUrl } from "@/lib/audio-cache";
import { presignedUrls } from "./engine/presigned-urls";
import { resetPrefetchState, warmTrack } from "./engine/prefetch";
import { __setAudioContextFactory, getElementVolume, initAudioCtx, isRouted } from "@/utils/audio-context";
import { FakeMediaSource, mp3Response, settle } from "@/test/helpers/fake-mse";
import { buildMp3, type Mp3Options } from "@/test/helpers/mp3";
import { parseGaplessInfo, type GaplessInfo } from "./engine/mp3-gapless";

// AudioEngine drives <audio> elements imperatively (new Audio()). This fake
// element records what the engine asks of it, and the tests play the
// browser's part: readiness, time updates, errors.

type Ranges = { length: number; start(i: number): number; end(i: number): number };
const ranges = (pairs: [number, number][] = []): Ranges => ({
	length: pairs.length,
	start: (i) => pairs[i][0],
	end: (i) => pairs[i][1],
});

class FakeAudio extends EventTarget {
	static all: FakeAudio[] = [];
	/** The browser's autoplay policy refuses play() (a tab that never had a click). */
	static blocked = false;
	preload = "";
	crossOrigin: string | null = null;
	readyState = 0;
	paused = true;
	seeking = false;
	currentTime = 0;
	duration = NaN;
	volume = 1;
	playbackRate = 1;
	networkState = 0;
	error: { code: number; message: string } | null = null;
	buffered: Ranges = ranges();
	seekable: Ranges = ranges();
	plays = 0;
	oncanplay: (() => void) | null = null;
	ontimeupdate: (() => void) | null = null;
	onended: (() => void) | null = null;
	onerror: (() => void) | null = null;
	onloadedmetadata: (() => void) | null = null;
	onwaiting: (() => void) | null = null;
	onplaying: (() => void) | null = null;
	onprogress: (() => void) | null = null;
	private _src = "";

	constructor() {
		super();
		FakeAudio.all.push(this);
	}
	// Like a real element: "" reads back as the document URL.
	get src() {
		return this._src;
	}
	set src(v: string) {
		this._src = new URL(v, window.location.href).href;
		this.readyState = 0;
		this.currentTime = 0;
		this.error = null;
	}
	get currentSrc() {
		return this._src;
	}
	load() {}
	play() {
		this.plays++;
		if (FakeAudio.blocked) return Promise.reject(new DOMException("play() needs a user gesture", "NotAllowedError"));
		this.paused = false;
		return Promise.resolve();
	}
	pause() {
		this.paused = true;
	}
	fire(type: string) {
		(this as unknown as Record<string, (() => void) | null>)[`on${type}`]?.();
		this.dispatchEvent(new Event(type));
	}
	/** The browser has metadata and enough data to play. */
	ready(duration: number, readyState = 4) {
		this.readyState = readyState;
		this.duration = duration;
		this.fire("loadedmetadata");
		this.fire("canplay");
	}
	tick(t: number) {
		this.currentTime = t;
		this.fire("timeupdate");
	}
	fail(code = 2) {
		this.error = { code, message: "network" };
		this.fire("error");
	}
}

const track = (id: string): PlayerTrack => ({
	trackId: id,
	title: `Track ${id}`,
	artist: "Artist",
	cover: null,
	duration: 200,
});

const INITIAL = usePlayerStore.getState();
// trackId → presigned URL the server would hand out (absent = not cached)
let stored: Record<string, string>;
let fetchMock: ReturnType<typeof vi.fn>;

const persistingRequests = () =>
	[
		...fetchMock.mock.calls.map(([u]) => String(u)),
		...FakeAudio.all.map((a) => a.src),
	].filter((u) => /\/api\/v1\/stream-progressive\/[^?]+$/.test(u) || /\/api\/v1\/stream\/[^?]+$/.test(u));

function elementWithSrc(pattern: RegExp): FakeAudio {
	const el = FakeAudio.all.findLast((a) => pattern.test(a.src));
	if (!el) throw new Error(`no element with src ${pattern}`);
	return el;
}

beforeEach(() => {
	FakeAudio.all = [];
	FakeAudio.blocked = false;
	vi.stubGlobal("Audio", FakeAudio);
	stored = {};
	fetchMock = vi.fn(async (input: RequestInfo | URL) => {
		const url = String(input);
		const m = /\/api\/v1\/stream-url\/([^/?]+)/.exec(url);
		if (m) {
			const hit = stored[decodeURIComponent(m[1])];
			return Response.json({
				success: true,
				data: hit
					? { url: hit, contentType: "audio/mpeg", expiresAt: new Date(Date.now() + 3_600_000).toISOString() }
					: { url: null, status: "not_cached" },
			});
		}
		if (/[?&]prefetch=1/.test(url)) return Response.json({ success: false, error: { code: "NOT_CACHED" } }, { status: 404 });
		return new Response(null, { status: 204 });
	});
	vi.stubGlobal("fetch", fetchMock);
	vi.mocked(getCachedBlobUrl).mockResolvedValue(null);
	vi.spyOn(console, "warn").mockImplementation(() => {});
	presignedUrls.reset();
	resetPrefetchState();
	__setAudioContextFactory(() => null);
	usePlayerStore.setState(INITIAL, true);
	localStorage.clear();
});

afterEach(() => {
	resetPrefetchState();
	__setAudioContextFactory();
	vi.unstubAllGlobals();
});

describe("AudioEngine — playback starts on every source", () => {
	it("plays a track the server never stored from the persisting live stream", async () => {
		render(<AudioEngine />);
		act(() => usePlayerStore.getState().play(track("1")));
		const el = await waitFor(() => elementWithSrc(/\/api\/v1\/stream-progressive\/1$/));
		act(() => el.ready(200));
		expect(el.plays).toBe(1);
		await waitFor(() => expect(el.volume).toBeCloseTo(0.8), { timeout: 5000 });
	});

	it("plays a stored track from its presigned R2 URL", async () => {
		stored["2"] = "https://r2.example/tracks/2/1.mp3?sig=1";
		render(<AudioEngine />);
		act(() => usePlayerStore.getState().play(track("2")));
		const el = await waitFor(() => elementWithSrc(/r2\.example\/tracks\/2\//));
		act(() => el.ready(200));
		expect(el.plays).toBe(1);
		await waitFor(() => expect(el.volume).toBeCloseTo(0.8), { timeout: 5000 });
	});

	it("plays an IndexedDB copy from its blob URL", async () => {
		vi.mocked(getCachedBlobUrl).mockImplementation(async (id) => (id === "3" ? "blob:http://localhost/3" : null));
		render(<AudioEngine />);
		act(() => usePlayerStore.getState().play(track("3")));
		const el = await waitFor(() => elementWithSrc(/^blob:http:\/\/localhost\/3$/));
		act(() => el.ready(200));
		expect(el.plays).toBe(1);
	});
});

describe("AudioEngine — Web Audio", () => {
	it("never routes an element into a suspended AudioContext: it keeps element.volume (no silent playback)", async () => {
		const ctx = { state: "suspended", resume: vi.fn(() => new Promise(() => {})), createAnalyser: vi.fn() };
		ctx.createAnalyser.mockReturnValue({ connect: vi.fn(), fftSize: 0, smoothingTimeConstant: 0 });
		__setAudioContextFactory(() => ctx as unknown as AudioContext);
		initAudioCtx();
		render(<AudioEngine />);
		act(() => usePlayerStore.getState().play(track("1")));
		const el = await waitFor(() => elementWithSrc(/stream-progressive\/1$/));
		act(() => el.ready(200));
		act(() => el.tick(1));
		expect(isRouted(el as unknown as HTMLAudioElement)).toBe(false);
		await waitFor(() => expect(el.volume).toBeCloseTo(0.8), { timeout: 5000 });
	});

	it("routes the element once the context runs, and its volume moves to its GainNode", async () => {
		const node = () => ({ connect: vi.fn(), disconnect: vi.fn(), fftSize: 0, smoothingTimeConstant: 0 });
		const gains: { gain: { value: number } }[] = [];
		const ctx = {
			state: "running",
			destination: node(),
			resume: vi.fn(async () => {}),
			createAnalyser: vi.fn(node),
			createMediaElementSource: vi.fn(node),
			createGain: vi.fn(() => {
				const g = { ...node(), gain: { value: 1 } };
				gains.push(g);
				return g;
			}),
		};
		__setAudioContextFactory(() => ctx as unknown as AudioContext);
		initAudioCtx();
		render(<AudioEngine />);
		act(() => usePlayerStore.getState().play(track("1")));
		const el = await waitFor(() => elementWithSrc(/stream-progressive\/1$/));
		act(() => el.ready(200));
		act(() => el.tick(1));
		const audio = el as unknown as HTMLAudioElement;
		expect(isRouted(audio)).toBe(true);
		await waitFor(() => expect(getElementVolume(audio)).toBeCloseTo(0.8));
		// element.volume stays at 1 (read-only on iOS); the last GainNode is the volume.
		expect(el.volume).toBe(1);
		expect(gains.at(-1)?.gain.value).toBeCloseTo(0.8);
	});
});

describe("AudioEngine — prefetch never persists", () => {
	it("starting a queue opens no persisting stream for the tracks around it", async () => {
		stored["2"] = "https://r2.example/tracks/2/1.mp3?sig=1";
		const queue = ["1", "2", "3", "4"].map(track);
		render(<AudioEngine />);
		act(() => usePlayerStore.getState().play(queue[0], queue));
		const el = await waitFor(() => elementWithSrc(/stream-progressive\/1$/));
		act(() => el.ready(200));
		await act(async () => {
			await new Promise((r) => setTimeout(r, 20));
		});
		// The playing track streams (and persists); 2, 3, 4 never do.
		expect(persistingRequests().every((u) => /\/1$/.test(u))).toBe(true);
		// The stored next track is preloaded from R2.
		expect(FakeAudio.all.some((a) => a.src.startsWith("https://r2.example/tracks/2/"))).toBe(true);
	});
});

describe("AudioEngine — fades", () => {
	it("a crossfaded track fades back in after a pause (was: its first resume jumped straight to full volume)", async () => {
		stored["1"] = "https://r2.example/tracks/1/1.mp3?sig=1";
		stored["2"] = "https://r2.example/tracks/2/1.mp3?sig=1";
		usePlayerStore.setState({ crossfadeDuration: 5 });
		const queue = [track("1"), track("2")];
		render(<AudioEngine />);
		act(() => usePlayerStore.getState().play(queue[0], queue));
		const first = await waitFor(() => elementWithSrc(/tracks\/1\//));
		act(() => first.ready(200));
		const second = await waitFor(() => elementWithSrc(/tracks\/2\//));
		second.readyState = 4;
		second.duration = 200;
		// 4 s left: the crossfade hands over to the preloaded next track.
		act(() => first.tick(196));
		expect(usePlayerStore.getState().currentTrack?.trackId).toBe("2");
		expect(second.plays).toBe(1);

		act(() => usePlayerStore.getState().pause());
		await waitFor(() => expect(second.paused).toBe(true));
		expect(second.volume).toBe(0);
		act(() => usePlayerStore.getState().resume());
		// A user resume starts from silence and fades in.
		expect(second.volume).toBe(0);
		await waitFor(() => expect(second.volume).toBeCloseTo(0.8), { timeout: 5000 });
	});

	it("the next track of the queue starts at full volume, with no fade-in", async () => {
		stored["1"] = "https://r2.example/tracks/1/1.mp3?sig=1";
		stored["2"] = "https://r2.example/tracks/2/1.mp3?sig=1";
		const queue = [track("1"), track("2")];
		render(<AudioEngine />);
		act(() => usePlayerStore.getState().play(queue[0], queue));
		const first = await waitFor(() => elementWithSrc(/tracks\/1\//));
		act(() => first.ready(200));
		const second = await waitFor(() => elementWithSrc(/tracks\/2\//));
		act(() => second.ready(200));
		act(() => first.fire("ended"));
		expect(usePlayerStore.getState().currentTrack?.trackId).toBe("2");
		expect(second.plays).toBe(1);
		expect(second.volume).toBeCloseTo(0.8);
	});

	it("a queue advance paused before it started fades in on resume (was: the user's resume skipped the fade-in)", async () => {
		stored["1"] = "https://r2.example/tracks/1/1.mp3?sig=1";
		stored["2"] = "https://r2.example/tracks/2/1.mp3?sig=1";
		const queue = [track("1"), track("2")];
		render(<AudioEngine />);
		act(() => usePlayerStore.getState().play(queue[0], queue));
		const first = await waitFor(() => elementWithSrc(/tracks\/1\//));
		act(() => first.ready(200));
		const second = await waitFor(() => elementWithSrc(/tracks\/2\//));
		act(() => first.fire("ended"));
		act(() => usePlayerStore.getState().pause());
		act(() => second.ready(200));
		expect(second.plays).toBe(0);
		// Real-timer fades: give them room under a loaded CI runner (was flaky at the 1 s default).
		await waitFor(() => expect(second.volume).toBe(0), { timeout: 5000 });
		act(() => usePlayerStore.getState().resume());
		expect(second.plays).toBe(1);
		expect(second.volume).toBe(0);
		await waitFor(() => expect(second.volume).toBeCloseTo(0.8), { timeout: 5000 });
	});
});

describe("AudioEngine — resuming on the live stream", () => {
	it("a retry on a live stream of unknown length resumes where it broke (was: restarted silently at 0)", async () => {
		render(<AudioEngine />);
		act(() => usePlayerStore.getState().play(track("1")));
		const el = await waitFor(() => elementWithSrc(/stream-progressive\/1$/));
		// No Content-Length on the live stream: the browser doesn't know the duration.
		act(() => el.ready(Infinity));
		act(() => el.tick(95));
		act(() => el.fail(2));
		// The retry reloads the live stream on the same element after 1 s.
		await waitFor(() => expect(el.readyState).toBe(0), { timeout: 8000 });
		await waitFor(() => expect(el.src).toMatch(/stream-progressive\/1$/), { timeout: 8000 });
		// Meanwhile the server stored the file.
		stored["1"] = "https://r2.example/tracks/1/1.mp3?sig=1";
		act(() => el.ready(Infinity));
		const file = await waitFor(() => elementWithSrc(/r2\.example\/tracks\/1\//));
		act(() => file.ready(200));
		expect(file.currentTime).toBe(95);
		expect(usePlayerStore.getState().currentTime).toBe(95);
	}, 20_000);
});

describe("AudioEngine — stop", () => {
	it("a stop before the source resolved loads nothing (was: the late URL opened the stopped track's persisting stream)", async () => {
		render(<AudioEngine />);
		act(() => usePlayerStore.getState().play(track("1")));
		act(() => usePlayerStore.getState().stop());
		await act(async () => {
			await new Promise((r) => setTimeout(r, 20));
		});
		expect(FakeAudio.all.filter((a) => /stream-progressive\/1/.test(a.src))).toEqual([]);
	});

	it("a stop cancels a seek waiting for the stored file (was: the stored file was loaded after the stop)", async () => {
		render(<AudioEngine />);
		act(() => usePlayerStore.getState().play(track("1")));
		const el = await waitFor(() => elementWithSrc(/stream-progressive\/1$/));
		act(() => el.ready(200));
		act(() => usePlayerStore.getState().seek(150));
		await waitFor(() => expect(el.src).not.toMatch(/stream-progressive/));
		act(() => usePlayerStore.getState().stop());
		stored["1"] = "https://r2.example/tracks/1/1.mp3?sig=1";
		await act(async () => {
			await new Promise((r) => setTimeout(r, 1200));
		});
		expect(FakeAudio.all.filter((a) => /r2\.example/.test(a.src))).toEqual([]);
	}, 20_000);
});

describe("AudioEngine — session restore", () => {
	it("a page refresh resumes where the track was left (was: the hydration render took the stop path and dropped the restored position, so it restarted at 0)", async () => {
		stored["1"] = "https://r2.example/tracks/1/1.mp3?sig=1";
		usePlayerStore.setState({ currentTrack: track("1"), queue: [track("1")], queueIndex: 0 });
		localStorage.setItem("wavelet-resume", JSON.stringify({ trackId: "1", time: 103.75, ts: Date.now() }));
		// Like the page load: React hydrates with the store's initial snapshot
		// (no track yet), then re-renders with the rehydrated one.
		const container = document.createElement("div");
		document.body.appendChild(container);
		const { hydrateRoot } = await import("react-dom/client");
		let root!: ReturnType<typeof hydrateRoot>;
		await act(async () => {
			root = hydrateRoot(container, <AudioEngine />);
		});
		const el = await waitFor(() => elementWithSrc(/r2\.example\/tracks\/1\//));
		el.seekable = ranges([[0, 320]]);
		act(() => el.ready(320));
		expect(el.currentTime).toBeCloseTo(103.75);
		act(() => root.unmount());
		container.remove();
	});
});

describe("AudioEngine — source recovery", () => {
	it("a presigned URL failing while still valid falls back to the proxy for that track, at the same position", async () => {
		stored["1"] = "https://r2.example/tracks/1/1.mp3?sig=1";
		render(<AudioEngine />);
		act(() => usePlayerStore.getState().play(track("1")));
		const el = await waitFor(() => elementWithSrc(/r2\.example\/tracks\/1\//));
		act(() => el.ready(200));
		act(() => el.tick(50));
		act(() => el.fail(2));
		await waitFor(() => expect(el.src).toMatch(/\/api\/v1\/stream\/1$/));
		act(() => el.ready(200));
		expect(el.currentTime).toBe(50);
		expect(presignedUrls.isDenied("1")).toBe(true);
	});

	it("a corrupt IndexedDB copy is evicted and the track reloads from the network", async () => {
		const { removeCached } = await import("@/lib/audio-cache");
		vi.mocked(getCachedBlobUrl).mockImplementation(async (id) => (id === "3" ? "blob:http://localhost/3" : null));
		stored["3"] = "https://r2.example/tracks/3/1.mp3?sig=1";
		render(<AudioEngine />);
		act(() => usePlayerStore.getState().play(track("3")));
		const el = await waitFor(() => elementWithSrc(/^blob:/));
		act(() => el.fail(4));
		expect(removeCached).toHaveBeenCalledWith("3");
		await waitFor(() => expect(el.src).toMatch(/r2\.example\/tracks\/3\//));
	});
});

describe("AudioEngine — play count", () => {
	const recentPlays = () => fetchMock.mock.calls.filter(([u]) => String(u) === "/api/v1/recent-plays");

	it("logs a play after 30 s really listened to, once", async () => {
		render(<AudioEngine />);
		act(() => usePlayerStore.getState().play(track("1")));
		const el = await waitFor(() => elementWithSrc(/stream-progressive\/1$/));
		act(() => el.ready(200));
		act(() => {
			for (let t = 0; t <= 31; t += 0.25) el.tick(t);
		});
		expect(recentPlays()).toHaveLength(1);
		act(() => el.tick(31.25));
		expect(recentPlays()).toHaveLength(1);
	});

	it("doesn't count a seek past 0:30 as a play", async () => {
		stored["1"] = "https://r2.example/tracks/1/1.mp3?sig=1";
		render(<AudioEngine />);
		act(() => usePlayerStore.getState().play(track("1")));
		const el = await waitFor(() => elementWithSrc(/r2\.example\/tracks\/1\//));
		act(() => el.ready(200));
		act(() => {
			el.tick(0);
			el.tick(0.25);
			el.tick(120);
			el.tick(120.25);
		});
		expect(recentPlays()).toHaveLength(0);
	});
});

describe("AudioEngine — long pause on a presigned URL", () => {
	it("resuming after the URL expired signs it again and resumes at the same position", async () => {
		stored["1"] = "https://r2.example/tracks/1/1.mp3?sig=1";
		render(<AudioEngine />);
		act(() => usePlayerStore.getState().play(track("1")));
		const el = await waitFor(() => elementWithSrc(/sig=1$/));
		act(() => el.ready(200));
		act(() => el.tick(42));
		act(() => usePlayerStore.getState().pause());
		await waitFor(() => expect(el.paused).toBe(true));
		const later = Date.now() + 2 * 3_600_000;
		vi.spyOn(Date, "now").mockReturnValue(later);
		stored["1"] = "https://r2.example/tracks/1/1.mp3?sig=2";
		act(() => usePlayerStore.getState().resume());
		await waitFor(() => expect(el.src).toMatch(/sig=2$/));
		act(() => el.ready(200));
		expect(el.currentTime).toBe(42);
		expect(el.paused).toBe(false);
	});
});

// --- Gapless runs (MSE deck) ------------------------------------------------

describe("AudioEngine — gapless runs", () => {
	const SR = 44100;
	// 2000 frames ≈ 52.2 s; 4100 frames ≈ 107 s.
	const mp3 = (frames: number, fill: number, extra: Partial<Mp3Options> = {}) => buildMp3({ frames, fill: () => fill, ...extra });
	const FLAC = Uint8Array.from("fLaC" + "\0".repeat(600), (c) => c.charCodeAt(0));
	let files: Record<string, Uint8Array>;
	let objectUrls: number;
	const revoked: string[] = [];
	const musicEnd = (file: Uint8Array) => (parseGaplessInfo(file) as { info: GaplessInfo }).info.totalSamples / SR;

	beforeEach(() => {
		FakeMediaSource.reset();
		vi.stubGlobal("MediaSource", FakeMediaSource);
		objectUrls = 0;
		revoked.length = 0;
		// The element attaches the source asynchronously, like a browser.
		Object.defineProperty(URL, "createObjectURL", {
			configurable: true,
			value: (ms: FakeMediaSource) => {
				setTimeout(() => ms.open(), 0);
				return `blob:http://localhost/ms-${++objectUrls}`;
			},
		});
		Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: (u: string) => revoked.push(u) });
		files = { "1": mp3(2000, 0x11), "2": mp3(2000, 0x22), "3": mp3(2000, 0x33) };
		for (const id of Object.keys(files)) stored[id] = `https://r2.example/tracks/${id}/1.mp3?sig=1`;
		const base = fetchMock.getMockImplementation() as (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
		fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
			const m = /^https:\/\/r2\.example\/tracks\/([^/]+)\//.exec(String(input));
			if (m && files[m[1]]) return mp3Response(files[m[1]]).response;
			return base(input, init);
		});
		usePlayerStore.setState({ gapless: true });
	});

	afterEach(() => {
		delete (URL as unknown as Record<string, unknown>).createObjectURL;
		delete (URL as unknown as Record<string, unknown>).revokeObjectURL;
	});

	const queue = () => ["1", "2", "3"].map(track);
	const deckElements = () => FakeAudio.all.filter((a) => a.src.startsWith("blob:http://localhost/ms-"));
	const r2Elements = (id: string) => FakeAudio.all.filter((a) => a.src.startsWith(`https://r2.example/tracks/${id}/`));
	const nextAppended = () =>
		waitFor(() => expect(FakeMediaSource.instances[0].sb.appends.some((a) => a.firstFill === 0x22)).toBe(true));
	const lastDeck = (not?: FakeAudio) =>
		waitFor(() => {
			const d = deckElements().at(-1);
			if (!d || d === not) throw new Error("no deck yet");
			return d;
		});

	/** Start the queue at `index` and let the deck open, append and report ready. */
	async function startRun(index = 0) {
		render(<AudioEngine />);
		const q = queue();
		act(() => usePlayerStore.getState().play(q[index], q));
		const el = await lastDeck();
		await act(() => settle());
		act(() => el.ready(Infinity));
		return el;
	}

	/** Play the run from `from` to `to` (timeline seconds), a timeupdate every 0.25 s. */
	async function playTo(el: FakeAudio, from: number, to: number) {
		act(() => {
			for (let x = from; x <= to; x += 0.25) el.tick(x);
		});
		await act(() => settle());
	}

	it("a play right after the hover preload started still runs gapless (was: the preload had no URL yet, so the first track took the plain path)", async () => {
		render(<AudioEngine />);
		const q = queue();
		// Hover: the preload element exists but its URL is still resolving.
		act(() => warmTrack("1", { audio: "full" }));
		act(() => usePlayerStore.getState().play(q[0], q));
		const el = await lastDeck();
		await act(() => settle());
		act(() => el.ready(Infinity));
		expect(el.plays).toBe(1);
		expect(r2Elements("1").filter((a) => !a.paused)).toEqual([]);
	});

	it("plays a run of cached MP3 tracks on one element and moves the queue at the boundary", async () => {
		const el = await startRun();
		expect(el.plays).toBe(1);
		const end1 = musicEnd(files["1"]);
		expect(usePlayerStore.getState().duration).toBeCloseTo(end1, 6);
		// From halfway on, the run lines the next track up itself: no element for it.
		await playTo(el, 0, 30);
		await nextAppended();
		expect(r2Elements("2")).toEqual([]);

		act(() => el.tick(end1 - 0.1));
		expect(usePlayerStore.getState().currentTrack?.trackId).toBe("1");
		act(() => el.tick(end1 + 0.3));
		const s = usePlayerStore.getState();
		expect(s.currentTrack?.trackId).toBe("2");
		expect(s.queueIndex).toBe(1);
		expect(s.isBuffering).toBe(false);
		expect(s.duration).toBeCloseTo(musicEnd(files["2"]), 6);
		expect(s.currentTime).toBeCloseTo(0.3, 6);
		// Still the same element, still playing at full volume: nothing reloads.
		await act(() => settle());
		expect(deckElements()).toEqual([el]);
		expect(el.paused).toBe(false);
		expect(el.volume).toBeCloseTo(0.8);
	});

	it("seeks within the current track of the run", async () => {
		const el = await startRun();
		const end1 = musicEnd(files["1"]);
		await playTo(el, 0, 30);
		await nextAppended();
		act(() => el.tick(end1 + 0.5));
		act(() => usePlayerStore.getState().seek(12));
		expect(el.currentTime).toBeCloseTo(end1 + 12, 6);
		expect(usePlayerStore.getState()._seekTo).toBeNull();
		act(() => el.tick(end1 + 12.25));
		expect(usePlayerStore.getState().currentTime).toBeCloseTo(12.25, 6);
	});

	it("pauses and resumes the run's element", async () => {
		const el = await startRun();
		act(() => usePlayerStore.getState().pause());
		await waitFor(() => expect(el.paused).toBe(true));
		act(() => usePlayerStore.getState().resume());
		expect(el.paused).toBe(false);
		expect(el.plays).toBe(2);
	});

	it("counts a play after 30 s listened in a run, and starts the next track's count at the boundary", async () => {
		const recentPlays = () => fetchMock.mock.calls.filter(([u]) => String(u) === "/api/v1/recent-plays");
		const el = await startRun();
		await playTo(el, 0, 31);
		expect(recentPlays()).toHaveLength(1);
		expect(JSON.parse(String(recentPlays()[0][1]?.body)).trackId).toBe("1");
		await nextAppended();
		const end1 = musicEnd(files["1"]);
		await playTo(el, end1 - 0.5, end1 + 31);
		expect(recentPlays()).toHaveLength(2);
		expect(JSON.parse(String(recentPlays()[1][1]?.body)).trackId).toBe("2");
	});

	it("updates the Media Session at the boundary, in track time", async () => {
		const session = { metadata: null as unknown, playbackState: "", setActionHandler: vi.fn(), setPositionState: vi.fn() };
		vi.stubGlobal(
			"MediaMetadata",
			class {
				constructor(public init: { title: string }) {}
			}
		);
		Object.defineProperty(navigator, "mediaSession", { configurable: true, value: session });
		try {
			const el = await startRun();
			const title = () => (session.metadata as { init: { title: string } }).init.title;
			expect(title()).toBe("Track 1");
			await playTo(el, 0, 30);
			await nextAppended();
			act(() => el.tick(musicEnd(files["1"]) + 1));
			expect(title()).toBe("Track 2");
			expect(session.setPositionState).toHaveBeenLastCalledWith(expect.objectContaining({ position: expect.closeTo(1, 6) }));
		} finally {
			delete (navigator as unknown as Record<string, unknown>).mediaSession;
		}
	});

	it("a track the user picks leaves the run cleanly (and may start its own)", async () => {
		const el = await startRun();
		act(() => usePlayerStore.getState().next());
		expect(revoked).toEqual(["blob:http://localhost/ms-1"]);
		expect(el.src).not.toMatch(/^blob:/);
		const second = await lastDeck(el);
		await act(() => settle());
		expect(FakeMediaSource.instances).toHaveLength(2);
		act(() => second.ready(Infinity));
		expect(usePlayerStore.getState().currentTrack?.trackId).toBe("2");
		expect(second.plays).toBe(1);
	});

	it("stop ends the run", async () => {
		const el = await startRun();
		act(() => usePlayerStore.getState().stop());
		expect(revoked).toEqual(["blob:http://localhost/ms-1"]);
		expect(el.paused).toBe(true);
		expect(el.src).not.toMatch(/^blob:/);
	});

	it("a page refresh resumes a gapless track where it was left", async () => {
		files["1"] = mp3(4100, 0x11);
		usePlayerStore.setState({ currentTrack: track("1"), queue: queue(), queueIndex: 0 });
		localStorage.setItem("wavelet-resume", JSON.stringify({ trackId: "1", time: 103.75, ts: Date.now() }));
		render(<AudioEngine />);
		const el = await lastDeck();
		await act(() => settle());
		act(() => el.ready(Infinity));
		expect(el.currentTime).toBeCloseTo(103.75, 6);
		expect(el.plays).toBe(0);
		await act(() => settle());
		// Re-appended from memory at the restored position.
		expect(FakeMediaSource.instances[0].sb.removes).toContainEqual([0, Infinity]);
	});

	it("a next track that can't join ends the run; the queue goes on on the plain path", async () => {
		files["2"] = FLAC;
		const el = await startRun();
		await playTo(el, 0, 30);
		const ms = FakeMediaSource.instances[0];
		await waitFor(() => expect(ms.endOfStreamCalls).toBe(1));
		// The plain path preloads it instead.
		act(() => el.tick(31));
		await waitFor(() => expect(r2Elements("2")).toHaveLength(1));
		act(() => el.fire("ended"));
		expect(usePlayerStore.getState().currentTrack?.trackId).toBe("2");
		expect(revoked).toEqual(["blob:http://localhost/ms-1"]);
	});

	it("sign-out drops the next track the run lined up", async () => {
		const { useAuthStore } = await import("@/stores/useAuthStore");
		useAuthStore.setState({ user: { id: "u1" } as never });
		const el = await startRun();
		await playTo(el, 0, 30);
		await nextAppended();
		act(() => useAuthStore.setState({ user: null }));
		await act(() => settle());
		expect(FakeMediaSource.instances[0].sb.removes).toContainEqual([musicEnd(files["1"]), Infinity]);
	});

	describe("falls back to the plain path", () => {
		const plainStart = async (id = "1") => {
			render(<AudioEngine />);
			const q = queue();
			act(() => usePlayerStore.getState().play(q[Number(id) - 1], q));
			return waitFor(() => {
				const el = r2Elements(id).at(-1);
				if (!el) throw new Error("no plain element");
				return el;
			});
		};

		it("with the setting off: today's path exactly, no Media Source", async () => {
			usePlayerStore.setState({ gapless: false });
			const el = await plainStart();
			act(() => el.ready(200));
			expect(el.plays).toBe(1);
			expect(FakeMediaSource.instances).toEqual([]);
		});

		it("with crossfade on", async () => {
			usePlayerStore.setState({ crossfadeDuration: 3 });
			await plainStart();
			expect(FakeMediaSource.instances).toEqual([]);
		});

		it("without MSE for MP3", async () => {
			FakeMediaSource.supported = false;
			await plainStart();
			expect(FakeMediaSource.instances).toEqual([]);
		});

		it("for a track the server never stored (live stream)", async () => {
			delete stored["1"];
			render(<AudioEngine />);
			act(() => usePlayerStore.getState().play(track("1"), queue()));
			await waitFor(() => elementWithSrc(/stream-progressive\/1$/));
			expect(FakeMediaSource.instances).toEqual([]);
		});

		it("when the next track isn't stored", async () => {
			delete stored["2"];
			await plainStart();
			expect(FakeMediaSource.instances).toEqual([]);
		});

		it("for a FLAC file", async () => {
			files["1"] = FLAC;
			const el = await plainStart();
			act(() => el.ready(200));
			expect(el.plays).toBe(1);
			expect(FakeMediaSource.instances).toEqual([]);
		});

		it("for an MP3 without a LAME tag", async () => {
			files["1"] = mp3(500, 0x11, { lame: false });
			await plainStart();
			expect(FakeMediaSource.instances).toEqual([]);
		});

		it("when the SourceBuffer runs out of quota mid-run: same position, and the rest of the run stays plain", async () => {
			files["1"] = mp3(4100, 0x11);
			const el = await startRun();
			await playTo(el, 0, 20);
			const sb = FakeMediaSource.instances[0].sb;
			sb.throwOnAppend = { name: "QuotaExceededError", times: 99 };
			// A jump ahead needs more appended than the browser will take.
			act(() => el.tick(50));
			await act(() => settle());
			const plain = await waitFor(() => {
				const p = r2Elements("1").at(-1);
				if (!p) throw new Error("no plain element");
				return p;
			});
			expect(revoked).toEqual(["blob:http://localhost/ms-1"]);
			act(() => plain.ready(200));
			expect(plain.currentTime).toBeCloseTo(50, 6);
			expect(plain.plays).toBe(1);
			act(() => plain.fire("ended"));
			await waitFor(() => expect(r2Elements("2").length).toBeGreaterThan(0));
			expect(FakeMediaSource.instances).toHaveLength(1);
		});

		it("when the run's element errors", async () => {
			const el = await startRun();
			await playTo(el, 0, 8);
			act(() => el.fail(3));
			const plain = await waitFor(() => {
				const p = r2Elements("1").at(-1);
				if (!p) throw new Error("no plain element");
				return p;
			});
			act(() => plain.ready(200));
			expect(plain.currentTime).toBeCloseTo(8, 6);
		});
	});
});

describe("AudioEngine — multi-device", () => {
	afterEach(() => {
		useSyncStore.getState().reset();
		setRemoteSender(null);
	});

	it("falls silent when another Device takes over (was: two Devices playing at once)", async () => {
		render(<AudioEngine />);
		act(() => usePlayerStore.getState().play(track("1")));
		const el = await waitFor(() => elementWithSrc(/stream-progressive\/1$/));
		act(() => el.ready(200));
		expect(el.paused).toBe(false);
		act(() => useSyncStore.getState().set({ role: "remote" }));
		expect(el.paused).toBe(true);
		expect(el.src).not.toMatch(/stream-progressive/);
	});

	it("a Transfer away is not a skip (was: the track was evicted from the cache)", async () => {
		render(<AudioEngine />);
		act(() => usePlayerStore.getState().play(track("1")));
		const el = await waitFor(() => elementWithSrc(/stream-progressive\/1$/));
		act(() => el.ready(200));
		act(() => el.tick(5));
		act(() => useSyncStore.getState().set({ role: "remote" }));
		expect(fetchMock.mock.calls.map(([u]) => String(u)).filter((u) => /\/skip$/.test(u))).toEqual([]);
	});

	it("loads nothing while a Remote, then plays the session's track from its position once active", async () => {
		stored["1"] = "https://r2.example/tracks/1/1.mp3?sig=1";
		useSyncStore.getState().set({ role: "remote" });
		usePlayerStore.setState({ currentTrack: track("1"), queue: [track("1")], queueIndex: 0, isPlaying: true, currentTime: 42 });
		render(<AudioEngine />);
		await act(async () => {
			await new Promise((r) => setTimeout(r, 20));
		});
		expect(FakeAudio.all.filter((a) => /tracks\/1\//.test(a.src))).toEqual([]);

		act(() => useSyncStore.getState().set({ role: "active" }));
		const el = await waitFor(() => elementWithSrc(/r2\.example\/tracks\/1\//));
		el.seekable = ranges([[0, 200]]);
		act(() => el.ready(200));
		expect(el.currentTime).toBeCloseTo(42);
		expect(el.plays).toBe(1);
	});

	it("a Transfer to a tab the browser won't let play pauses and asks for a click (was: shown playing, no sound)", async () => {
		stored["1"] = "https://r2.example/tracks/1/1.mp3?sig=1";
		useSyncStore.getState().set({ role: "remote" });
		usePlayerStore.setState({ currentTrack: track("1"), queue: [track("1")], queueIndex: 0, isPlaying: true, currentTime: 42 });
		render(<AudioEngine />);
		FakeAudio.blocked = true;
		act(() => useSyncStore.getState().set({ role: "active" }));
		const el = await waitFor(() => elementWithSrc(/r2\.example\/tracks\/1\//));
		el.seekable = ranges([[0, 200]]);
		await act(async () => el.ready(200));
		expect(usePlayerStore.getState().isPlaying).toBe(false);
		expect(toast).toHaveBeenCalledWith(
			"Click to play here",
			expect.objectContaining({ id: "play-blocked", action: expect.objectContaining({ label: "Play" }) })
		);

		// The prompt's button is the click the browser wants.
		FakeAudio.blocked = false;
		const [, opts] = vi.mocked(toast).mock.calls.find(([title]) => title === "Click to play here")!;
		const plays = el.plays;
		await act(async () => (opts as unknown as { action: { onClick: () => void } }).action.onClick());
		expect(usePlayerStore.getState().isPlaying).toBe(true);
		expect(el.plays).toBe(plays + 1);
		expect(el.paused).toBe(false);
		expect(toast.dismiss).toHaveBeenCalledWith("play-blocked");
	});

	it("a Preview on a Remote pauses the Active Device, which stays paused afterwards (CONTEXT.md, Preview)", async () => {
		const sent: unknown[] = [];
		setRemoteSender((c) => sent.push(c));
		useSyncStore.getState().set({ role: "remote" });
		usePlayerStore.setState({ currentTrack: track("1"), queue: [track("1")], queueIndex: 0, isPlaying: true });
		render(<AudioEngine />);
		act(() => usePreviewStore.setState({ currentTrack: { trackId: "p" } as never, isPlaying: true }));
		expect(sent).toEqual([{ type: "pause" }]);
		act(() => usePreviewStore.setState({ currentTrack: null, isPlaying: false }));
		expect(sent).toEqual([{ type: "pause" }]);
	});
});
