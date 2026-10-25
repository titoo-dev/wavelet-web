import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useDownloadedAlbums } from "./useDownloadedAlbums";
import { useAuthStore } from "@/stores/useAuthStore";

const page = (...items: { id: string; deezerAlbumId: string }[]) =>
	Response.json({ success: true, data: { items } });

describe("useDownloadedAlbums", () => {
	let fetchMock: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		useAuthStore.setState({ isAuthenticated: true });
		fetchMock = vi.fn(async () => page({ id: "alb-1", deezerAlbumId: "302127" }));
		vi.stubGlobal("fetch", fetchMock);
	});

	afterEach(() => {
		useAuthStore.setState({ isAuthenticated: false });
		vi.unstubAllGlobals();
	});

	it("maps the saved albums' Deezer ids to library ids once signed in", async () => {
		const { result } = renderHook(() => useDownloadedAlbums());
		await waitFor(() => expect(result.current.albumMap.get("302127")).toBe("alb-1"));
		expect(fetchMock).toHaveBeenCalledWith("/api/v1/library/albums", { credentials: "include" });
	});

	it("fetches nothing for a guest", async () => {
		useAuthStore.setState({ isAuthenticated: false });
		const { result } = renderHook(() => useDownloadedAlbums());
		await act(async () => {});
		expect(fetchMock).not.toHaveBeenCalled();
		expect(result.current.albumMap.size).toBe(0);
	});

	it("drops the albums on sign-out (was: the previous account's Saved badges stayed)", async () => {
		const { result } = renderHook(() => useDownloadedAlbums());
		await waitFor(() => expect(result.current.albumMap.size).toBe(1));
		act(() => useAuthStore.setState({ isAuthenticated: false }));
		expect(result.current.albumMap.size).toBe(0);
	});

	it("ignores an answer that lands after sign-out (was: set from inside the effect, it filled the map anyway)", async () => {
		let answer!: (r: Response) => void;
		fetchMock.mockImplementation(() => new Promise<Response>((resolve) => (answer = resolve)));
		const { result } = renderHook(() => useDownloadedAlbums());
		await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
		act(() => useAuthStore.setState({ isAuthenticated: false }));
		await act(async () => answer(page({ id: "alb-1", deezerAlbumId: "302127" })));
		act(() => useAuthStore.setState({ isAuthenticated: true }));
		expect(result.current.albumMap.get("302127")).toBeUndefined();
	});

	it("refresh() reloads the map", async () => {
		const { result } = renderHook(() => useDownloadedAlbums());
		await waitFor(() => expect(result.current.albumMap.size).toBe(1));
		fetchMock.mockImplementation(async () =>
			page({ id: "alb-1", deezerAlbumId: "302127" }, { id: "alb-2", deezerAlbumId: "9410100" })
		);
		await act(() => result.current.refresh());
		expect(result.current.albumMap.get("9410100")).toBe("alb-2");
	});
});
