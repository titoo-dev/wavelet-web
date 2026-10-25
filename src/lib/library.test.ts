import { describe, it, expect, vi, beforeEach } from "vitest";
import { prismaMock, resetPrismaMock } from "@/test/helpers/mockPrisma";

vi.mock("@/lib/prisma", () => ({ prisma: prismaMock }));
vi.mock("@/lib/server-state", () => ({
	getWaveletApp: vi.fn(async () => null),
}));

import {
	saveTrack,
	unsaveTrack,
	isTrackSaved,
	getSavedTrackIds,
	listSavedTracks,
	saveAlbum,
	unsaveAlbum,
	listSavedAlbums,
	getSavedAlbumIds,
	getTrackRefCount,
	maybeEvictFile,
	forceEvictFile,
	isPreCacheEnabled,
	reorderPlaylist,
	followArtist,
	unfollowArtist,
	isArtistFollowed,
	getFollowedArtistIds,
	listFollowedArtists,
	shareTrack,
	resolveShareForPlayback,
	EVICTION_GRACE_MS,
} from "./library";
import { getWaveletApp } from "@/lib/server-state";

const getWaveletAppMock = vi.mocked(getWaveletApp);

beforeEach(() => {
	resetPrismaMock();
	getWaveletAppMock.mockReset();
	getWaveletAppMock.mockResolvedValue(null);
});

describe("saveTrack", () => {
	it("upserts on userId_trackId composite and returns the row", async () => {
		const row = { id: "s1", userId: "u1", trackId: "t1" };
		prismaMock.savedTrack.upsert.mockResolvedValue(row);

		const result = await saveTrack("u1", {
			trackId: "t1",
			title: "Hello",
			artist: "Adele",
			album: "25",
			albumId: "a1",
			coverUrl: "http://cover/1.jpg",
			duration: 295,
		});

		expect(result).toBe(row);
		expect(prismaMock.savedTrack.upsert).toHaveBeenCalledWith({
			where: { userId_trackId: { userId: "u1", trackId: "t1" } },
			update: {},
			create: {
				userId: "u1",
				trackId: "t1",
				title: "Hello",
				artist: "Adele",
				album: "25",
				albumId: "a1",
				coverUrl: "http://cover/1.jpg",
				duration: 295,
			},
		});
	});

	it("defaults optional fields to null when omitted", async () => {
		prismaMock.savedTrack.upsert.mockResolvedValue({});
		await saveTrack("u1", {
			trackId: "t1",
			title: "T",
			artist: "A",
		});
		const args = prismaMock.savedTrack.upsert.mock.calls[0][0];
		expect(args.create).toMatchObject({
			album: null,
			albumId: null,
			coverUrl: null,
			duration: null,
		});
	});
});

describe("unsaveTrack", () => {
	it("deletes the saved row for the user and attempts to evict", async () => {
		prismaMock.savedTrack.deleteMany.mockResolvedValue({ count: 1 });
		// Force refs to all be 0 so maybeEvictFile -> forceEvictFile is called
		prismaMock.savedTrack.count.mockResolvedValue(0);
		prismaMock.albumTrack.count.mockResolvedValue(0);
		prismaMock.sharedTrack.count.mockResolvedValue(0);
		prismaMock.recentPlay.count.mockResolvedValue(0);
		prismaMock.storedTrack.findMany.mockResolvedValue([]);

		await unsaveTrack("u1", "t1");

		expect(prismaMock.savedTrack.deleteMany).toHaveBeenCalledWith({
			where: { userId: "u1", trackId: "t1" },
		});
	});

	it("does not call forceEvictFile when there are still references", async () => {
		prismaMock.savedTrack.deleteMany.mockResolvedValue({ count: 1 });
		prismaMock.savedTrack.count.mockResolvedValue(1);
		prismaMock.albumTrack.count.mockResolvedValue(0);
		prismaMock.sharedTrack.count.mockResolvedValue(0);
		prismaMock.recentPlay.count.mockResolvedValue(0);

		await unsaveTrack("u1", "t1");

		expect(prismaMock.storedTrack.findMany).not.toHaveBeenCalled();
		expect(prismaMock.storedTrack.deleteMany).not.toHaveBeenCalled();
	});
});

describe("isTrackSaved", () => {
	it("returns true when a row is found", async () => {
		prismaMock.savedTrack.findUnique.mockResolvedValue({ id: "x" });
		const result = await isTrackSaved("u1", "t1");
		expect(result).toBe(true);
		expect(prismaMock.savedTrack.findUnique).toHaveBeenCalledWith({
			where: { userId_trackId: { userId: "u1", trackId: "t1" } },
			select: { id: true },
		});
	});

	it("returns false when no row exists", async () => {
		prismaMock.savedTrack.findUnique.mockResolvedValue(null);
		const result = await isTrackSaved("u1", "t1");
		expect(result).toBe(false);
	});
});

describe("getSavedTrackIds", () => {
	it("returns an empty Set without hitting Prisma when given no ids", async () => {
		const result = await getSavedTrackIds("u1", []);
		expect(result).toBeInstanceOf(Set);
		expect(result.size).toBe(0);
		expect(prismaMock.savedTrack.findMany).not.toHaveBeenCalled();
	});

	it("returns a Set of saved trackIds for the user", async () => {
		prismaMock.savedTrack.findMany.mockResolvedValue([
			{ trackId: "t1" },
			{ trackId: "t3" },
		]);

		const result = await getSavedTrackIds("u1", ["t1", "t2", "t3"]);
		expect(result).toBeInstanceOf(Set);
		expect([...result].sort()).toEqual(["t1", "t3"]);
		expect(prismaMock.savedTrack.findMany).toHaveBeenCalledWith({
			where: { userId: "u1", trackId: { in: ["t1", "t2", "t3"] } },
			select: { trackId: true },
		});
	});
});

describe("listSavedTracks", () => {
	it("orders by savedAt desc and passes take/skip from opts", async () => {
		const items = [{ id: "1" }, { id: "2" }];
		prismaMock.savedTrack.findMany.mockResolvedValue(items);

		const result = await listSavedTracks("u1", { limit: 50, offset: 25 });
		expect(result).toBe(items);
		expect(prismaMock.savedTrack.findMany).toHaveBeenCalledWith({
			where: { userId: "u1" },
			orderBy: { savedAt: "desc" },
			take: 50,
			skip: 25,
		});
	});

	it("passes undefined take/skip when no opts provided", async () => {
		prismaMock.savedTrack.findMany.mockResolvedValue([]);
		await listSavedTracks("u1");
		expect(prismaMock.savedTrack.findMany).toHaveBeenCalledWith({
			where: { userId: "u1" },
			orderBy: { savedAt: "desc" },
			take: undefined,
			skip: undefined,
		});
	});
});

describe("saveAlbum", () => {
	it("upserts the album, deletes existing tracks, and creates the new tracklist", async () => {
		const saved = { id: "alb-internal-1" };
		prismaMock.album.upsert.mockResolvedValue(saved);
		prismaMock.albumTrack.deleteMany.mockResolvedValue({ count: 0 });
		prismaMock.albumTrack.createMany.mockResolvedValue({ count: 2 });

		const result = await saveAlbum(
			"u1",
			{
				deezerAlbumId: "deezer-abc",
				title: "Album Title",
				artist: "Artist",
				coverUrl: "http://cover.jpg",
			},
			[
				{
					trackId: "t1",
					title: "Track 1",
					artist: "Artist",
					duration: 200,
					trackNumber: 1,
				},
				{
					trackId: "t2",
					title: "Track 2",
					artist: "Artist",
				},
			]
		);

		expect(result).toBe(saved);

		expect(prismaMock.album.upsert).toHaveBeenCalledWith({
			where: {
				userId_deezerAlbumId: { userId: "u1", deezerAlbumId: "deezer-abc" },
			},
			update: {
				title: "Album Title",
				artist: "Artist",
				coverUrl: "http://cover.jpg",
				trackCount: 2,
			},
			create: {
				userId: "u1",
				deezerAlbumId: "deezer-abc",
				title: "Album Title",
				artist: "Artist",
				coverUrl: "http://cover.jpg",
				trackCount: 2,
			},
		});

		expect(prismaMock.albumTrack.deleteMany).toHaveBeenCalledWith({
			where: { albumId: "alb-internal-1" },
		});

		expect(prismaMock.albumTrack.createMany).toHaveBeenCalledWith({
			data: [
				{
					albumId: "alb-internal-1",
					trackId: "t1",
					title: "Track 1",
					artist: "Artist",
					coverUrl: null,
					duration: 200,
					trackNumber: 1,
				},
				{
					albumId: "alb-internal-1",
					trackId: "t2",
					title: "Track 2",
					artist: "Artist",
					coverUrl: null,
					duration: null,
					trackNumber: null,
				},
			],
			skipDuplicates: true,
		});
	});

	it("does not call createMany when there are no tracks", async () => {
		prismaMock.album.upsert.mockResolvedValue({ id: "alb-1" });
		prismaMock.albumTrack.deleteMany.mockResolvedValue({ count: 0 });

		await saveAlbum(
			"u1",
			{ deezerAlbumId: "d", title: "T", artist: "A" },
			[]
		);

		expect(prismaMock.albumTrack.deleteMany).toHaveBeenCalledWith({
			where: { albumId: "alb-1" },
		});
		expect(prismaMock.albumTrack.createMany).not.toHaveBeenCalled();
	});
});

describe("unsaveAlbum", () => {
	it("returns early when the album doesn't exist", async () => {
		prismaMock.album.findUnique.mockResolvedValue(null);
		await unsaveAlbum("u1", "deezer-x");
		expect(prismaMock.album.delete).not.toHaveBeenCalled();
	});

	it("deletes the album and tries to evict files for each track", async () => {
		prismaMock.album.findUnique.mockResolvedValue({
			id: "alb-1",
			tracks: [{ trackId: "t1" }, { trackId: "t2" }],
		});
		prismaMock.album.delete.mockResolvedValue({});
		prismaMock.savedTrack.count.mockResolvedValue(0);
		prismaMock.albumTrack.count.mockResolvedValue(0);
		prismaMock.sharedTrack.count.mockResolvedValue(0);
		prismaMock.recentPlay.count.mockResolvedValue(0);
		prismaMock.storedTrack.findMany.mockResolvedValue([]);

		await unsaveAlbum("u1", "deezer-abc");

		expect(prismaMock.album.delete).toHaveBeenCalledWith({
			where: { id: "alb-1" },
		});
		// 2 tracks × 4 ref counts = 8 .count() calls
		expect(prismaMock.savedTrack.count).toHaveBeenCalledTimes(2);
		expect(prismaMock.albumTrack.count).toHaveBeenCalledTimes(2);
	});
});

describe("listSavedAlbums", () => {
	it("returns albums ordered by savedAt desc", async () => {
		const items = [{ id: "a1" }, { id: "a2" }];
		prismaMock.album.findMany.mockResolvedValue(items);

		const result = await listSavedAlbums("u1");
		expect(result).toBe(items);
		expect(prismaMock.album.findMany).toHaveBeenCalledWith({
			where: { userId: "u1" },
			orderBy: { savedAt: "desc" },
		});
	});
});

describe("getSavedAlbumIds", () => {
	it("returns an empty Set without hitting Prisma when given no ids", async () => {
		const result = await getSavedAlbumIds("u1", []);
		expect(result).toBeInstanceOf(Set);
		expect(result.size).toBe(0);
		expect(prismaMock.album.findMany).not.toHaveBeenCalled();
	});

	it("returns a Set of saved deezerAlbumIds for the user", async () => {
		prismaMock.album.findMany.mockResolvedValue([
			{ deezerAlbumId: "a1" },
			{ deezerAlbumId: "a3" },
		]);

		const result = await getSavedAlbumIds("u1", ["a1", "a2", "a3"]);
		expect([...result].sort()).toEqual(["a1", "a3"]);
		expect(prismaMock.album.findMany).toHaveBeenCalledWith({
			where: { userId: "u1", deezerAlbumId: { in: ["a1", "a2", "a3"] } },
			select: { deezerAlbumId: true },
		});
	});
});

describe("getTrackRefCount", () => {
	it("aggregates counts from all 4 ref tables", async () => {
		prismaMock.savedTrack.count.mockResolvedValue(2);
		prismaMock.albumTrack.count.mockResolvedValue(3);
		prismaMock.sharedTrack.count.mockResolvedValue(1);
		prismaMock.recentPlay.count.mockResolvedValue(4);

		const result = await getTrackRefCount("t1");
		expect(result).toEqual({
			saved: 2,
			album: 3,
			shared: 1,
			recent: 4,
			total: 10,
		});

		expect(prismaMock.savedTrack.count).toHaveBeenCalledWith({
			where: { trackId: "t1" },
		});
		expect(prismaMock.albumTrack.count).toHaveBeenCalledWith({
			where: { trackId: "t1" },
		});
		expect(prismaMock.recentPlay.count).toHaveBeenCalledWith({
			where: { trackId: "t1" },
		});
	});

	it("counts only live share links (was: an expired link anchored the file forever)", async () => {
		const now = Date.parse("2026-10-09T12:00:00.000Z");
		await getTrackRefCount("t1", now);
		expect(prismaMock.sharedTrack.count).toHaveBeenCalledWith({
			where: { trackId: "t1", OR: [{ expiresAt: null }, { expiresAt: { gt: new Date(now) } }] },
		});
	});
});

describe("forceEvictFile", () => {
	it("returns 0 and skips work when no StoredTrack rows exist", async () => {
		prismaMock.storedTrack.findMany.mockResolvedValue([]);
		const result = await forceEvictFile("t1");
		expect(result).toBe(0);
		expect(prismaMock.storedTrack.deleteMany).not.toHaveBeenCalled();
		expect(prismaMock.sharedTrack.updateMany).not.toHaveBeenCalled();
	});

	it("nulls SharedTrack.storedTrackId and deletes StoredTrack rows", async () => {
		prismaMock.storedTrack.findMany.mockResolvedValue([
			{ id: "st1", storagePath: "/p1" },
			{ id: "st2", storagePath: "/p2" },
		]);
		prismaMock.sharedTrack.updateMany.mockResolvedValue({ count: 0 });
		prismaMock.storedTrack.deleteMany.mockResolvedValue({ count: 2 });

		// no storage provider => deleted counter stays 0
		const result = await forceEvictFile("t1");
		expect(result).toBe(0);

		expect(prismaMock.sharedTrack.updateMany).toHaveBeenCalledWith({
			where: { storedTrackId: { in: ["st1", "st2"] } },
			data: { storedTrackId: null },
		});
		expect(prismaMock.storedTrack.deleteMany).toHaveBeenCalledWith({
			where: { id: { in: ["st1", "st2"] } },
		});
	});

	it("calls storageProvider.deleteFile for each row when one exists", async () => {
		const deleteFile = vi.fn().mockResolvedValue(undefined);
		getWaveletAppMock.mockResolvedValue({
			storageProvider: { deleteFile },
		} as never);
		prismaMock.storedTrack.findMany.mockResolvedValue([
			{ id: "st1", storagePath: "/p1" },
			{ id: "st2", storagePath: "/p2" },
		]);
		prismaMock.sharedTrack.updateMany.mockResolvedValue({ count: 0 });
		prismaMock.storedTrack.deleteMany.mockResolvedValue({ count: 2 });

		const result = await forceEvictFile("t1");
		expect(result).toBe(2);
		expect(deleteFile).toHaveBeenCalledTimes(2);
		expect(deleteFile).toHaveBeenCalledWith("/p1");
		expect(deleteFile).toHaveBeenCalledWith("/p2");
	});
});

describe("maybeEvictFile", () => {
	it("triggers forceEvictFile when total refs are 0", async () => {
		prismaMock.savedTrack.count.mockResolvedValue(0);
		prismaMock.albumTrack.count.mockResolvedValue(0);
		prismaMock.sharedTrack.count.mockResolvedValue(0);
		prismaMock.recentPlay.count.mockResolvedValue(0);
		prismaMock.storedTrack.findMany.mockResolvedValue([]);

		await maybeEvictFile("t1");

		expect(prismaMock.storedTrack.findMany).toHaveBeenCalledWith({
			where: { trackId: "t1" },
			select: { id: true, storagePath: true },
		});
	});

	it("does not call forceEvictFile when refs > 0", async () => {
		prismaMock.savedTrack.count.mockResolvedValue(0);
		prismaMock.albumTrack.count.mockResolvedValue(0);
		prismaMock.sharedTrack.count.mockResolvedValue(1);
		prismaMock.recentPlay.count.mockResolvedValue(0);

		await maybeEvictFile("t1");

		expect(prismaMock.storedTrack.findMany).not.toHaveBeenCalled();
	});
});

describe("isPreCacheEnabled", () => {
	it("returns true when preferences.preCacheSaved is true", async () => {
		prismaMock.userPreferences.findUnique.mockResolvedValue({
			preferences: { preCacheSaved: true },
		});

		const result = await isPreCacheEnabled("u1");
		expect(result).toBe(true);
		expect(prismaMock.userPreferences.findUnique).toHaveBeenCalledWith({
			where: { userId: "u1" },
			select: { preferences: true },
		});
	});

	it("returns false when preferences.preCacheSaved is missing/false", async () => {
		prismaMock.userPreferences.findUnique.mockResolvedValue({
			preferences: { other: true },
		});
		expect(await isPreCacheEnabled("u1")).toBe(false);

		prismaMock.userPreferences.findUnique.mockResolvedValue({
			preferences: { preCacheSaved: false },
		});
		expect(await isPreCacheEnabled("u1")).toBe(false);
	});

	it("returns false when no UserPreferences row exists", async () => {
		prismaMock.userPreferences.findUnique.mockResolvedValue(null);
		expect(await isPreCacheEnabled("u1")).toBe(false);
	});
});

describe("reorderPlaylist", () => {
	it("rewrites positions 0..N-1 in the supplied order and bumps the playlist updatedAt", async () => {
		prismaMock.playlistTrack.findMany.mockResolvedValue([
			{ trackId: "a" },
			{ trackId: "b" },
			{ trackId: "c" },
		]);
		prismaMock.$transaction.mockResolvedValue([]);
		prismaMock.playlist.update.mockResolvedValue({});
		// Each .update returns a thenable so the array we pass to $transaction is well-typed.
		prismaMock.playlistTrack.update.mockResolvedValue({});

		const result = await reorderPlaylist("pl1", ["c", "a", "b"]);

		expect(result).toEqual({ reordered: 3 });
		expect(prismaMock.playlistTrack.findMany).toHaveBeenCalledWith({
			where: { playlistId: "pl1" },
			select: { trackId: true },
		});
		// Three updates queued, one per (trackId, newPosition).
		expect(prismaMock.playlistTrack.update).toHaveBeenNthCalledWith(1, {
			where: { playlistId_trackId: { playlistId: "pl1", trackId: "c" } },
			data: { position: 0 },
		});
		expect(prismaMock.playlistTrack.update).toHaveBeenNthCalledWith(2, {
			where: { playlistId_trackId: { playlistId: "pl1", trackId: "a" } },
			data: { position: 1 },
		});
		expect(prismaMock.playlistTrack.update).toHaveBeenNthCalledWith(3, {
			where: { playlistId_trackId: { playlistId: "pl1", trackId: "b" } },
			data: { position: 2 },
		});
		expect(prismaMock.$transaction).toHaveBeenCalledTimes(1);
		expect(prismaMock.playlist.update).toHaveBeenCalledWith({
			where: { id: "pl1" },
			data: { updatedAt: expect.any(Date) },
		});
	});

	it("throws REORDER_LENGTH_MISMATCH when the supplied order has the wrong number of trackIds", async () => {
		prismaMock.playlistTrack.findMany.mockResolvedValue([
			{ trackId: "a" },
			{ trackId: "b" },
		]);

		await expect(reorderPlaylist("pl1", ["a"])).rejects.toThrow("REORDER_LENGTH_MISMATCH");
		await expect(reorderPlaylist("pl1", ["a", "b", "c"])).rejects.toThrow(
			"REORDER_LENGTH_MISMATCH"
		);
		// No writes attempted when validation fails up front.
		expect(prismaMock.$transaction).not.toHaveBeenCalled();
		expect(prismaMock.playlistTrack.update).not.toHaveBeenCalled();
	});

	it("throws REORDER_DUPLICATE_TRACK when the supplied order repeats a trackId", async () => {
		prismaMock.playlistTrack.findMany.mockResolvedValue([
			{ trackId: "a" },
			{ trackId: "b" },
		]);

		await expect(reorderPlaylist("pl1", ["a", "a"])).rejects.toThrow(
			"REORDER_DUPLICATE_TRACK"
		);
		expect(prismaMock.$transaction).not.toHaveBeenCalled();
	});

	it("throws REORDER_UNKNOWN_TRACK when a supplied trackId is not part of the playlist", async () => {
		prismaMock.playlistTrack.findMany.mockResolvedValue([
			{ trackId: "a" },
			{ trackId: "b" },
		]);

		await expect(reorderPlaylist("pl1", ["a", "z"])).rejects.toThrow(
			"REORDER_UNKNOWN_TRACK"
		);
		expect(prismaMock.$transaction).not.toHaveBeenCalled();
	});
});

describe("followArtist", () => {
	it("upserts on userId_deezerArtistId composite and returns the row", async () => {
		const row = { id: "f1", userId: "u1", deezerArtistId: "27" };
		prismaMock.followedArtist.upsert.mockResolvedValue(row);

		const result = await followArtist("u1", {
			deezerArtistId: "27",
			name: "Daft Punk",
			pictureUrl: "http://cdn/artist/27.jpg",
		});

		expect(result).toBe(row);
		expect(prismaMock.followedArtist.upsert).toHaveBeenCalledWith({
			where: { userId_deezerArtistId: { userId: "u1", deezerArtistId: "27" } },
			update: {
				name: "Daft Punk",
				pictureUrl: "http://cdn/artist/27.jpg",
			},
			create: {
				userId: "u1",
				deezerArtistId: "27",
				name: "Daft Punk",
				pictureUrl: "http://cdn/artist/27.jpg",
			},
		});
	});

	it("normalizes a missing pictureUrl to null on both update and create branches", async () => {
		prismaMock.followedArtist.upsert.mockResolvedValue({});

		await followArtist("u1", { deezerArtistId: "27", name: "Daft Punk" });

		const call = prismaMock.followedArtist.upsert.mock.calls[0][0];
		expect(call.update.pictureUrl).toBeNull();
		expect(call.create.pictureUrl).toBeNull();
	});
});

describe("unfollowArtist", () => {
	it("removes the (userId, deezerArtistId) row when it exists", async () => {
		prismaMock.followedArtist.deleteMany.mockResolvedValue({ count: 1 });

		await unfollowArtist("u1", "27");

		expect(prismaMock.followedArtist.deleteMany).toHaveBeenCalledWith({
			where: { userId: "u1", deezerArtistId: "27" },
		});
	});

	it("is idempotent — deleteMany returning count:0 does not throw", async () => {
		prismaMock.followedArtist.deleteMany.mockResolvedValue({ count: 0 });
		await expect(unfollowArtist("u1", "doesnotexist")).resolves.toBeUndefined();
	});
});

describe("isArtistFollowed", () => {
	it("returns true when the (userId, deezerArtistId) row exists", async () => {
		prismaMock.followedArtist.findUnique.mockResolvedValue({ id: "f1" });
		expect(await isArtistFollowed("u1", "27")).toBe(true);
	});

	it("returns false when no row exists", async () => {
		prismaMock.followedArtist.findUnique.mockResolvedValue(null);
		expect(await isArtistFollowed("u1", "27")).toBe(false);
	});
});

describe("getFollowedArtistIds", () => {
	it("returns the set of deezerArtistIds the user follows from the supplied list", async () => {
		prismaMock.followedArtist.findMany.mockResolvedValue([
			{ deezerArtistId: "27" },
			{ deezerArtistId: "55" },
		]);

		const result = await getFollowedArtistIds("u1", ["27", "55", "99"]);
		expect(result).toEqual(new Set(["27", "55"]));
		expect(prismaMock.followedArtist.findMany).toHaveBeenCalledWith({
			where: { userId: "u1", deezerArtistId: { in: ["27", "55", "99"] } },
			select: { deezerArtistId: true },
		});
	});

	it("short-circuits on empty input — no DB call", async () => {
		const result = await getFollowedArtistIds("u1", []);
		expect(result).toEqual(new Set());
		expect(prismaMock.followedArtist.findMany).not.toHaveBeenCalled();
	});
});

describe("listFollowedArtists", () => {
	it("returns the user's followed artists ordered by followedAt desc", async () => {
		const rows = [
			{ id: "f1", deezerArtistId: "27" },
			{ id: "f2", deezerArtistId: "55" },
		];
		prismaMock.followedArtist.findMany.mockResolvedValue(rows);

		const result = await listFollowedArtists("u1");
		expect(result).toBe(rows);
		expect(prismaMock.followedArtist.findMany).toHaveBeenCalledWith({
			where: { userId: "u1" },
			orderBy: { followedAt: "desc" },
			take: undefined,
			skip: undefined,
		});
	});

	it("forwards limit + offset to Prisma when supplied", async () => {
		prismaMock.followedArtist.findMany.mockResolvedValue([]);

		await listFollowedArtists("u1", { limit: 20, offset: 40 });

		expect(prismaMock.followedArtist.findMany).toHaveBeenCalledWith({
			where: { userId: "u1" },
			orderBy: { followedAt: "desc" },
			take: 20,
			skip: 40,
		});
	});
});

describe("shareTrack", () => {
	it("links the best copy by quality rank (was: orderBy bitrate desc linked MP3_MISC=8 over MP3_320=3)", async () => {
		prismaMock.storedTrack.findMany.mockResolvedValue([
			{ id: "misc", trackId: "t1", bitrate: 8, storagePath: "tracks/t1/8.mp3", storageType: "r2" },
			{ id: "hq", trackId: "t1", bitrate: 3, storagePath: "tracks/t1/3.mp3", storageType: "r2" },
		] as never);
		prismaMock.sharedTrack.create.mockImplementation(async (args: { data: Record<string, unknown> }) => args.data);

		const share = await shareTrack("u1", { trackId: "t1", title: "T", artist: "A" });
		expect(share.storedTrackId).toBe("hq");
		expect(share.shareId).toMatch(/^[0-9a-f]{16}$/);
	});

	it("creates an unlinked share when nothing is cached", async () => {
		prismaMock.storedTrack.findMany.mockResolvedValue([] as never);
		prismaMock.sharedTrack.create.mockImplementation(async (args: { data: Record<string, unknown> }) => args.data);
		const share = await shareTrack("u1", { trackId: "t1", title: "T", artist: "A" }, { expiresAt: null });
		expect(share.storedTrackId).toBeNull();
	});
});

describe("resolveShareForPlayback", () => {
	const share = { id: "s1", shareId: "abc", trackId: "t1", userId: "owner", storedTrackId: null, expiresAt: null };

	it("returns null for an unknown share", async () => {
		prismaMock.sharedTrack.findUnique.mockResolvedValue(null);
		expect(await resolveShareForPlayback("nope")).toBeNull();
	});

	it("flags an expired share without looking up a copy", async () => {
		prismaMock.sharedTrack.findUnique.mockResolvedValue({ ...share, expiresAt: new Date(Date.now() - 1000) } as never);
		const r = await resolveShareForPlayback("abc");
		expect(r).toMatchObject({ expired: true, copy: null });
		expect(prismaMock.storedTrack.findMany).not.toHaveBeenCalled();
	});

	it("finds the copy persisted after the share was created and re-links it (was: share.storedTrack stayed null, every visit re-downloaded from Deezer)", async () => {
		prismaMock.sharedTrack.findUnique.mockResolvedValue(share as never);
		prismaMock.storedTrack.findMany.mockResolvedValue([
			{ id: "st1", trackId: "t1", bitrate: 1, storagePath: "tracks/t1/1.mp3", storageType: "r2" },
		] as never);
		prismaMock.sharedTrack.update.mockResolvedValue({} as never);

		const r = await resolveShareForPlayback("abc");
		expect(r).toMatchObject({ expired: false, copy: { id: "st1", storagePath: "tracks/t1/1.mp3" } });
		expect(prismaMock.storedTrack.findMany).toHaveBeenCalledWith({ where: { trackId: "t1" } });
		expect(prismaMock.sharedTrack.update).toHaveBeenCalledWith({ where: { id: "s1" }, data: { storedTrackId: "st1" } });
	});

	it("serves the best copy without asking for an upgrade (public listeners have no licence)", async () => {
		getWaveletAppMock.mockResolvedValue({ freshSettings: vi.fn(async () => ({ maxBitrate: 9 })) } as never);
		prismaMock.sharedTrack.findUnique.mockResolvedValue({ ...share, storedTrackId: "st1" } as never);
		prismaMock.storedTrack.findMany.mockResolvedValue([
			{ id: "st1", trackId: "t1", bitrate: 1, requestedBitrate: 1, storagePath: "tracks/t1/1.mp3", storageType: "r2" },
		] as never);

		const r = await resolveShareForPlayback("abc");
		expect(r?.copy?.id).toBe("st1");
		expect(prismaMock.sharedTrack.update).not.toHaveBeenCalled();
	});

	it("returns no copy when only older storage rows exist, and survives a failed re-link", async () => {
		prismaMock.sharedTrack.findUnique.mockResolvedValue(share as never);
		prismaMock.storedTrack.findMany.mockResolvedValue([
			{ id: "old", trackId: "t1", bitrate: 1, storagePath: "music/x.mp3", storageType: "blob" },
		] as never);
		expect((await resolveShareForPlayback("abc"))?.copy).toBeNull();

		prismaMock.storedTrack.findMany.mockResolvedValue([
			{ id: "st1", trackId: "t1", bitrate: 1, storagePath: "tracks/t1/1.mp3", storageType: "r2" },
		] as never);
		prismaMock.sharedTrack.update.mockRejectedValue(new Error("db"));
		expect((await resolveShareForPlayback("abc"))?.copy?.id).toBe("st1");
	});
});

describe("eviction guards", () => {
	function noRefs() {
		prismaMock.savedTrack.count.mockResolvedValue(0 as never);
		prismaMock.albumTrack.count.mockResolvedValue(0 as never);
		prismaMock.sharedTrack.count.mockResolvedValue(0 as never);
		prismaMock.recentPlay.count.mockResolvedValue(0 as never);
	}

	it("keeps an object that another StoredTrack row still points at (was: evicting one legacy row deleted another track's file)", async () => {
		const deleteFile = vi.fn().mockResolvedValue(undefined);
		getWaveletAppMock.mockResolvedValue({ storageProvider: { deleteFile } } as never);
		prismaMock.storedTrack.findMany.mockResolvedValue([
			{ id: "st1", storagePath: "music/Artist - Song.mp3" },
			{ id: "st2", storagePath: "tracks/t1/3.mp3" },
		] as never);
		prismaMock.storedTrack.count.mockImplementation((async (args: { where: { storagePath: string } }) =>
			args.where.storagePath === "music/Artist - Song.mp3" ? 1 : 0) as never);

		const deleted = await forceEvictFile("t1");
		expect(deleted).toBe(1);
		expect(deleteFile).toHaveBeenCalledTimes(1);
		expect(deleteFile).toHaveBeenCalledWith("tracks/t1/3.mp3");
		expect(prismaMock.storedTrack.count).toHaveBeenCalledWith({
			where: { storagePath: "music/Artist - Song.mp3", id: { notIn: ["st1", "st2"] } },
		});
		// Both rows of this track are still dropped.
		expect(prismaMock.storedTrack.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ["st1", "st2"] } } });
	});

	it("does not evict a copy persisted less than 10 minutes ago (was: a skip right after the first play evicted the file just cached for everyone)", async () => {
		noRefs();
		prismaMock.persistLease.count.mockResolvedValue(0 as never);
		prismaMock.storedTrack.count.mockResolvedValue(1 as never);

		const r = await maybeEvictFile("t1");
		expect(r).toEqual({ evicted: 0, kept: "recent" });
		expect(prismaMock.storedTrack.count).toHaveBeenCalledWith({
			where: { trackId: "t1", createdAt: { gt: expect.any(Date) } },
		});
		const cutoff = prismaMock.storedTrack.count.mock.calls[0][0].where.createdAt.gt as Date;
		expect(Date.now() - cutoff.getTime()).toBeGreaterThanOrEqual(EVICTION_GRACE_MS - 1000);
		expect(prismaMock.storedTrack.findMany).not.toHaveBeenCalled();
	});

	it("does not evict while a persist lease is held (was: a skip during the persist left an orphan that was never evicted)", async () => {
		noRefs();
		prismaMock.persistLease.count.mockResolvedValue(1 as never);

		const r = await maybeEvictFile("t1");
		expect(r).toEqual({ evicted: 0, kept: "persisting" });
		expect(prismaMock.storedTrack.findMany).not.toHaveBeenCalled();
	});

	it("reports anchored tracks and evictions", async () => {
		prismaMock.savedTrack.count.mockResolvedValue(1 as never);
		prismaMock.albumTrack.count.mockResolvedValue(0 as never);
		prismaMock.sharedTrack.count.mockResolvedValue(0 as never);
		prismaMock.recentPlay.count.mockResolvedValue(0 as never);
		expect(await maybeEvictFile("t1")).toEqual({ evicted: 0, kept: "anchored" });

		noRefs();
		prismaMock.persistLease.count.mockResolvedValue(0 as never);
		prismaMock.storedTrack.count.mockResolvedValue(0 as never);
		prismaMock.storedTrack.findMany.mockResolvedValue([] as never);
		expect(await maybeEvictFile("t1")).toEqual({ evicted: 0 });
	});
});
