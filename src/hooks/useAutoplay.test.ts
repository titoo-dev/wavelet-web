import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";

vi.mock("@/utils/haptic", () => ({ haptic: vi.fn() }));

import { autoplayRequestFor, useAutoplay, type AutoplayInput } from "./useAutoplay";
import { usePlayerStore, type PlayerTrack } from "@/stores/usePlayerStore";
import { useAuthStore } from "@/stores/useAuthStore";
import { useSyncStore } from "@/lib/playback-sync/useSyncStore";

const track = (id: string, artistId: string | null = `a${id}`): PlayerTrack => ({
	trackId: id,
	title: `Track ${id}`,
	artist: "Artist",
	artistId,
	cover: null,
	duration: 200,
});
const queueOf = (...ids: string[]) => ids.map((id) => track(id));

describe("autoplayRequestFor", () => {
	const input = (over: Partial<AutoplayInput> = {}): AutoplayInput => {
		const queue = over.queue ?? queueOf("1", "2", "3");
		const queueIndex = over.queueIndex ?? queue.length - 1;
		return { autoplay: true, isPlaying: true, repeat: "off", queue, queueIndex, currentTrack: queue[queueIndex] ?? null, ...over };
	};

	it("asks once the last track of the queue plays, with the latest tracks as seeds (current first)", () => {
		const req = autoplayRequestFor(input({ queue: queueOf("1", "2", "3", "4", "5", "6", "7") }));
		expect(req?.afterTrackId).toBe("7");
		expect(req?.body.seeds.map((s) => s.trackId)).toEqual(["7", "6", "5", "4", "3"]);
		expect(req?.body.seeds[0].artistId).toBe("a7");
		expect(req?.body.exclude).toEqual(["1", "2", "3", "4", "5", "6", "7"]);
		expect(req?.key).toBe("7@6/7");
	});

	it("asks nothing before the last track, on repeat, while paused, when off, or with nothing playing", () => {
		expect(autoplayRequestFor(input({ queueIndex: 1 }))).toBeNull();
		expect(autoplayRequestFor(input({ repeat: "all" }))).toBeNull();
		expect(autoplayRequestFor(input({ repeat: "one" }))).toBeNull();
		expect(autoplayRequestFor(input({ isPlaying: false }))).toBeNull();
		expect(autoplayRequestFor(input({ autoplay: false }))).toBeNull();
		expect(autoplayRequestFor(input({ currentTrack: null }))).toBeNull();
		expect(autoplayRequestFor(input({ queue: [], queueIndex: -1 }))).toBeNull();
	});

	it("sends a seed without artist as such", () => {
		const queue = [track("1", null)];
		expect(autoplayRequestFor(input({ queue }))?.body.seeds).toEqual([{ trackId: "1", artistId: null }]);
	});
});

describe("useAutoplay", () => {
	const INITIAL = usePlayerStore.getState();
	let fetchMock: ReturnType<typeof vi.fn>;
	const calls = () => fetchMock.mock.calls.filter(([u]) => String(u) === "/api/v1/autoplay");

	beforeEach(() => {
		usePlayerStore.setState(INITIAL, true);
		useAuthStore.setState({ isAuthenticated: true });
		useSyncStore.getState().reset();
		fetchMock = vi.fn(async () =>
			Response.json({ success: true, data: { tracks: [track("8"), track("9")], seedArtistIds: ["a2"] } })
		);
		vi.stubGlobal("fetch", fetchMock);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		useAuthStore.setState({ isAuthenticated: false });
		useSyncStore.getState().reset();
	});

	it("appends similar tracks when the last track starts, once", async () => {
		renderHook(() => useAutoplay());
		act(() => usePlayerStore.getState().playQueue(queueOf("1", "2"), 0));
		expect(calls()).toHaveLength(0);
		act(() => usePlayerStore.getState().next());
		await waitFor(() => expect(usePlayerStore.getState().queue.map((t) => t.trackId)).toEqual(["1", "2", "8", "9"]));
		act(() => usePlayerStore.getState().setCurrentTime(10));
		expect(calls()).toHaveLength(1);
		expect(JSON.parse(String(calls()[0][1].body)).seeds[0]).toEqual({ trackId: "2", artistId: "a2" });
	});

	it("asks again when the autoplayed tracks run out in turn", async () => {
		renderHook(() => useAutoplay());
		act(() => usePlayerStore.getState().playQueue(queueOf("1"), 0));
		await waitFor(() => expect(usePlayerStore.getState().queue).toHaveLength(3));
		fetchMock.mockImplementation(async () => Response.json({ success: true, data: { tracks: [track("10")] } }));
		act(() => usePlayerStore.getState().jumpToIndex(2));
		await waitFor(() => expect(usePlayerStore.getState().queue.map((t) => t.trackId)).toEqual(["1", "8", "9", "10"]));
	});

	it("asks nothing when signed out, nor on a Remote", async () => {
		useAuthStore.setState({ isAuthenticated: false });
		const { rerender } = renderHook(() => useAutoplay());
		act(() => usePlayerStore.getState().playQueue(queueOf("1"), 0));
		expect(calls()).toHaveLength(0);
		act(() => useSyncStore.getState().set({ role: "remote" }));
		act(() => useAuthStore.setState({ isAuthenticated: true }));
		rerender();
		act(() => usePlayerStore.getState().setCurrentTime(5));
		expect(calls()).toHaveLength(0);
	});

	it("leaves the queue as it is when the request fails", async () => {
		fetchMock.mockRejectedValue(new TypeError("offline"));
		renderHook(() => useAutoplay());
		act(() => usePlayerStore.getState().playQueue(queueOf("1"), 0));
		await waitFor(() => expect(calls()).toHaveLength(1));
		expect(usePlayerStore.getState().queue).toHaveLength(1);
	});
});
