import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("@/hooks/useLibrary", () => ({
	useSavedTracks: () => ({ isSaved: () => false, save: vi.fn(), unsave: vi.fn() }),
}));

import { TrackActionMenu } from "./TrackActionMenu";
import { useAuthStore } from "@/stores/useAuthStore";

const track = { id: "42", title: "Nofy", artist: "Hosea Marlyn" };

beforeEach(() => {
	useAuthStore.setState({ isAuthenticated: true });
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => new Response(JSON.stringify({ success: true, data: [{ id: "p1", title: "Chill", _count: { tracks: 3 } }] })))
	);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("TrackActionMenu — song radio", () => {
	it("links to the track's song radio", async () => {
		const user = userEvent.setup();
		render(<TrackActionMenu track={track} />);
		await user.click(screen.getByRole("button", { name: "Track actions" }));
		expect((await screen.findByText("Go to song radio")).closest("a")).toHaveAttribute("href", "/radio?track=42");
	});

	it("has no radio entry signed out", async () => {
		useAuthStore.setState({ isAuthenticated: false });
		const user = userEvent.setup();
		render(<TrackActionMenu track={track} />);
		await user.click(screen.getByRole("button", { name: "Track actions" }));
		await screen.findByText("Nofy");
		expect(screen.queryByText("Go to song radio")).toBeNull();
	});
});

describe("TrackActionMenu — new playlist field (HK-08)", () => {
	it("Escape leaves the name field and keeps the playlist list open (was: Escape was swallowed and the field stayed)", async () => {
		const user = userEvent.setup();
		render(<TrackActionMenu track={track} />);
		await user.click(screen.getByRole("button", { name: "Track actions" }));
		await user.click(await screen.findByText("Add to playlist"));
		await user.click(await screen.findByText("New playlist"));
		const field = await screen.findByPlaceholderText("Playlist name");
		await user.type(field, "Road trip");
		await user.keyboard("{Escape}");
		expect(screen.queryByPlaceholderText("Playlist name")).toBeNull();
		expect(screen.getByText("Chill")).toBeInTheDocument();
		expect(screen.getByText("New playlist")).toBeInTheDocument();
	});

	it("letters typed in the field stay in the field (the menu's typeahead doesn't take them)", async () => {
		const user = userEvent.setup();
		render(<TrackActionMenu track={track} />);
		await user.click(screen.getByRole("button", { name: "Track actions" }));
		await user.click(await screen.findByText("Add to playlist"));
		await user.click(await screen.findByText("New playlist"));
		const field = await screen.findByPlaceholderText("Playlist name");
		await user.type(field, "Chill 2");
		expect(field).toHaveValue("Chill 2");
		expect(field).toHaveFocus();
	});
});
