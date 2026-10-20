import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";

vi.mock("@/utils/haptic", () => ({ haptic: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }), usePathname: () => "/" }));

import { DailyMixCard, artistLine } from "./DailyMixCard";
import { localDay } from "@/hooks/useDailyMix";
import { usePlayerStore } from "@/stores/usePlayerStore";
import { useAuthStore } from "@/stores/useAuthStore";

const track = (id: string, artist = "Daft Punk") => ({
	trackId: id,
	title: `Song ${id}`,
	artist,
	artistId: "27",
	album: null,
	albumId: null,
	cover: `https://cdn/${id}.jpg`,
	duration: 200,
});
const mix = (over: Record<string, unknown> = {}) => ({
	day: "2026-10-20",
	basedOn: "taste",
	artists: ["Daft Punk", "Justice", "Kavinsky"],
	tracks: [track("1"), track("2", "Justice"), track("3", "Kavinsky")],
	...over,
});
const INITIAL = usePlayerStore.getState();
let fetchMock: ReturnType<typeof vi.fn>;
const answer = (data: unknown, success = true) => fetchMock.mockResolvedValue(Response.json(success ? { success, data } : { success, error: { code: "X" } }));

beforeEach(() => {
	usePlayerStore.setState(INITIAL, true);
	useAuthStore.setState({ isAuthenticated: true });
	fetchMock = vi.fn();
	vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
	vi.unstubAllGlobals();
	useAuthStore.setState({ isAuthenticated: false });
});

describe("artistLine", () => {
	it("joins the names", () => {
		expect(artistLine([])).toBe("");
		expect(artistLine(["A"])).toBe("A");
		expect(artistLine(["A", "B", "C"])).toBe("A, B and C");
	});
});

describe("localDay", () => {
	it("is the viewer's date, not UTC's", () => {
		expect(localDay(new Date(2026, 0, 5, 23, 30))).toBe("2026-01-05");
	});
});

describe("DailyMixCard", () => {
	it("asks for the viewer's day and shows the mix with its artists", async () => {
		answer(mix());
		render(<DailyMixCard />);
		expect(await screen.findByText("Daily Mix")).toBeTruthy();
		expect(screen.getByText("Daft Punk, Justice and Kavinsky, and more like them")).toBeTruthy();
		expect(String(fetchMock.mock.calls[0][0])).toBe(`/api/v1/mixes/daily?day=${localDay()}`);
	});

	it("plays the mix from the start, its tracks tagged daily-mix", async () => {
		answer(mix());
		render(<DailyMixCard />);
		fireEvent.click(await screen.findByRole("button", { name: "Play Daily Mix" }));
		const s = usePlayerStore.getState();
		expect(s.queue.map((t) => t.trackId)).toEqual(["1", "2", "3"]);
		expect(s.queue.every((t) => t.source === "daily-mix")).toBe(true);
		expect(s.currentTrack?.trackId).toBe("1");
	});

	it("shuffle turns shuffle on and plays", async () => {
		answer(mix());
		render(<DailyMixCard />);
		fireEvent.click(await screen.findByRole("button", { name: "Shuffle" }));
		expect(usePlayerStore.getState().shuffle).toBe(true);
		expect(usePlayerStore.getState().queue).toHaveLength(3);
	});

	it("opens its tracks", async () => {
		answer(mix());
		render(<DailyMixCard />);
		fireEvent.click(await screen.findByRole("button", { name: "Tracks" }));
		expect(await screen.findByText("Song 2")).toBeTruthy();
	});

	it("says where a Flow mix comes from", async () => {
		answer(mix({ basedOn: "flow", artists: [] }));
		render(<DailyMixCard />);
		expect(await screen.findByText("From your Deezer Flow, while we learn your taste")).toBeTruthy();
	});

	it("New mix asks for a fresh one", async () => {
		answer(mix());
		render(<DailyMixCard />);
		fireEvent.click(await screen.findByRole("button", { name: "New mix" }));
		await waitFor(() => expect(String(fetchMock.mock.calls[1]?.[0])).toMatch(/&refresh=1$/));
	});

	it.each([
		["an empty mix", () => answer(mix({ tracks: [] }))],
		["an error", () => answer(null, false)],
		["a network failure", () => fetchMock.mockRejectedValue(new TypeError("offline"))],
	])("shows nothing for %s", async (_label, arrange) => {
		arrange();
		const { container } = render(<DailyMixCard />);
		await waitFor(() => expect(container.querySelector("[aria-busy]")).toBeNull());
		expect(screen.queryByText("Daily Mix")).toBeNull();
	});
});
