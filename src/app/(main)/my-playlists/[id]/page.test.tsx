import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const push = vi.fn();
const replace = vi.fn();
vi.mock("next/navigation", () => ({
	useParams: () => ({ id: "abc" }),
	useRouter: () => ({ push, replace }),
	usePathname: () => "/my-playlists/abc",
}));
vi.mock("@/hooks/useUserPreferences", () => ({ useUserPreferences: () => ({ prefs: {}, updatePrefs: vi.fn() }) }));
vi.mock("@/hooks/usePrefetch", () => ({ usePrefetch: () => {} }));
vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }) }));

import PlaylistDetailPage from "./page";
import { useAuthStore } from "@/stores/useAuthStore";

const PLAYLIST = {
	id: "abc",
	title: "Late night private mix",
	description: null,
	tracks: [{ id: "pt1", trackId: "1", title: "Secret song", artist: "Someone", album: null, albumId: null, coverUrl: null, duration: 200, position: 0 }],
};

beforeEach(() => {
	push.mockReset();
	replace.mockReset();
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => new Response(JSON.stringify({ success: true, data: PLAYLIST })))
	);
});

describe("my-playlists/[id] — signed out", () => {
	it("hides the playlist once signed out (NAV-06, was: private tracks stayed on screen after Log out)", async () => {
		useAuthStore.setState({ isAuthenticated: true, isLoading: false });
		render(<PlaylistDetailPage />);
		expect(await screen.findByText("Late night private mix")).toBeInTheDocument();
		act(() => useAuthStore.getState().logout());
		expect(screen.queryByText("Late night private mix")).toBeNull();
		expect(screen.queryByText("Secret song")).toBeNull();
	});

	it("asks a guest to sign in and come back (NAV-07, was: 'Playlist not found')", () => {
		useAuthStore.setState({ isAuthenticated: false, isLoading: false });
		render(<PlaylistDetailPage />);
		expect(screen.queryByText("Playlist not found")).toBeNull();
		expect(screen.getByRole("link", { name: /Sign in/ })).toHaveAttribute("href", expect.stringMatching(/^\/login/));
	});
});

describe("my-playlists/[id] — search in playlist", () => {
	const track = (n: number, title: string, artist: string) => ({ id: `pt${n}`, trackId: String(n), title, artist, album: null, albumId: null, coverUrl: null, duration: 200, position: n - 1 });
	const MIX = { ...PLAYLIST, tracks: [track(1, "Crazy in Love", "Beyoncé"), track(2, "Get Lucky", "Daft Punk"), track(3, "Halo", "Beyoncé")] };

	beforeEach(() => {
		useAuthStore.setState({ isAuthenticated: true, isLoading: false });
		vi.mocked(fetch).mockImplementation(async () => new Response(JSON.stringify({ success: true, data: MIX })));
	});

	it("shows only the matching tracks, numbered by their place, and pauses reordering", async () => {
		render(<PlaylistDetailPage />);
		await screen.findByText("Get Lucky");
		expect(screen.getAllByRole("button", { name: /Drag to reorder/ })).toHaveLength(3);

		await userEvent.type(screen.getByRole("searchbox", { name: "Search in playlist" }), "beyonce");
		await waitFor(() => expect(screen.queryByText("Get Lucky")).toBeNull());
		expect(screen.getByText("Crazy in Love")).toBeInTheDocument();
		expect(screen.getByText("Halo")).toBeInTheDocument();
		expect(screen.getByText("Clear the search to reorder")).toBeInTheDocument();
		await waitFor(() => expect(screen.queryByRole("button", { name: /Drag to reorder/ })).toBeNull());
	});

	it("says so when nothing matches", async () => {
		render(<PlaylistDetailPage />);
		await screen.findByText("Get Lucky");
		await userEvent.type(screen.getByRole("searchbox", { name: "Search in playlist" }), "zzz");
		expect(await screen.findByText("No results for “zzz”")).toBeInTheDocument();
	});
});

describe("my-playlists/[id] — delete (NAV-14)", () => {
	it("replaces the deleted playlist in the history (was: Back opened 'Playlist not found')", async () => {
		useAuthStore.setState({ isAuthenticated: true, isLoading: false });
		render(<PlaylistDetailPage />);
		await screen.findByText("Late night private mix");
		vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ success: true }), { status: 200 }));
		await userEvent.click(screen.getByRole("button", { name: "More options" }));
		await userEvent.click(await screen.findByRole("menuitem", { name: /Delete playlist/ }));
		await userEvent.click(await screen.findByRole("button", { name: /^Delete$/ }));
		await waitFor(() => expect(replace).toHaveBeenCalledWith("/my-playlists"));
		expect(push).not.toHaveBeenCalledWith("/my-playlists");
	});
});
