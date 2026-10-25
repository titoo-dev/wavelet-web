import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const search = { current: "track=1" };
vi.mock("next/navigation", () => ({
	useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
	useSearchParams: () => new URLSearchParams(search.current),
	usePathname: () => "/radio",
}));

import RadioPage from "./page";
import { useAuthStore } from "@/stores/useAuthStore";
import { usePlayerStore } from "@/stores/usePlayerStore";
import { radioIsUpNext, radioQueue, type TrackRadio } from "@/hooks/useTrackRadio";

const PLAYER = usePlayerStore.getState();
const t = (id: string) => ({ trackId: id, title: `Song ${id}`, artist: `Artist ${id}`, artistId: `a${id}`, album: null, albumId: null, cover: null, duration: 200 });
const RADIO: TrackRadio = { seed: t("1"), tracks: [t("2"), t("3")] };

const respond = (status: number, body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status }));

beforeEach(() => {
	search.current = "track=1";
	usePlayerStore.setState(PLAYER, true);
	useAuthStore.setState({ isAuthenticated: true, isLoading: false });
	vi.stubGlobal("fetch", respond(200, { success: true, data: RADIO }));
	// Rows reveal on scroll (motion `whileInView`).
	vi.stubGlobal(
		"IntersectionObserver",
		class {
			observe() {}
			unobserve() {}
			disconnect() {}
		}
	);
});

afterEach(() => vi.unstubAllGlobals());

describe("radio helpers", () => {
	it("plays the seed first, every song tagged track-radio", () => {
		const q = radioQueue(RADIO);
		expect(q.map((x) => x.trackId)).toEqual(["1", "2", "3"]);
		expect(new Set(q.map((x) => x.source))).toEqual(new Set(["track-radio"]));
	});

	it("knows when the radio is what comes after the current track", () => {
		const q = radioQueue(RADIO);
		expect(radioIsUpNext(RADIO, q, 0)).toBe(true);
		expect(radioIsUpNext(RADIO, [q[0], t("9")], 0)).toBe(false);
		expect(radioIsUpNext({ ...RADIO, tracks: [] }, q, 0)).toBe(false);
	});
});

describe("/radio?track=", () => {
	it("shows the seed and the songs like it, from the track radio route", async () => {
		render(<RadioPage />);
		expect(await screen.findByText("Songs like it")).toBeInTheDocument();
		expect(screen.getAllByText("Song 1").length).toBeGreaterThan(0);
		expect(screen.getByText("Song 2")).toBeInTheDocument();
		expect(screen.getByText("Seed")).toBeInTheDocument();
		expect(fetch).toHaveBeenCalledWith("/api/v1/tracks/1/radio", { credentials: "include" });
	});

	it("Play radio plays the seed then the radio, tagged track-radio", async () => {
		render(<RadioPage />);
		await userEvent.click(await screen.findByRole("button", { name: "Play radio" }));
		const { queue, queueIndex } = usePlayerStore.getState();
		expect(queue.map((x) => x.trackId)).toEqual(["1", "2", "3"]);
		expect(queue.every((x) => x.source === "track-radio")).toBe(true);
		expect(queueIndex).toBe(0);
	});

	it("while the seed plays, lines the radio up behind it without restarting it", async () => {
		const other = t("9");
		usePlayerStore.setState({ currentTrack: t("1"), queue: [t("1"), other], queueIndex: 0 });
		render(<RadioPage />);
		await userEvent.click(await screen.findByRole("button", { name: "Play after this song" }));
		const { queue, currentTrack } = usePlayerStore.getState();
		expect(currentTrack?.trackId).toBe("1");
		expect(queue.map((x) => x.trackId)).toEqual(["1", "2", "3"]);
		expect(queue.slice(1).every((x) => x.source === "track-radio")).toBe(true);
		expect(await screen.findByRole("button", { name: "Radio is up next" })).toBeInTheDocument();
	});

	it("says so when nothing similar was found", async () => {
		vi.stubGlobal("fetch", respond(200, { success: true, data: { ...RADIO, tracks: [] } }));
		render(<RadioPage />);
		expect(await screen.findByText("Nothing similar yet")).toBeInTheDocument();
	});

	it("asks a guest to sign in, without calling the route", async () => {
		useAuthStore.setState({ isAuthenticated: false, isLoading: false });
		render(<RadioPage />);
		expect(await screen.findByText("Sign in to discover songs that sound like this one.")).toBeInTheDocument();
		expect(fetch).not.toHaveBeenCalled();
	});

	it("has no radio for a track Deezer doesn't know", async () => {
		vi.stubGlobal("fetch", respond(404, { success: false, error: { code: "NOT_FOUND" } }));
		render(<RadioPage />);
		expect(await screen.findByText("No radio for this song")).toBeInTheDocument();
	});

	it("offers a retry when the route failed", async () => {
		const failing = vi.fn().mockRejectedValueOnce(new TypeError("Failed to fetch")).mockResolvedValue(new Response(JSON.stringify({ success: true, data: RADIO })));
		vi.stubGlobal("fetch", failing);
		render(<RadioPage />);
		await userEvent.click(await screen.findByRole("button", { name: /Try again/ }));
		await waitFor(() => expect(screen.getByText("Songs like it")).toBeInTheDocument());
	});
});
