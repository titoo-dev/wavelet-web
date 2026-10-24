import { describe, it, expect } from "vitest";
import {
	StorageNotFoundError,
	StorageUnavailableError,
	inferContentType,
	isStorageNotFound,
	isStorageUnavailable,
	toObjectKey,
	trackExtension,
	trackObjectKey,
	TRACKS_PREFIX,
} from "./objects";

describe("toObjectKey", () => {
	it("strips leading slashes", () => {
		expect(toObjectKey("/data/music/A/B.mp3")).toBe("data/music/A/B.mp3");
		expect(toObjectKey("///x.flac")).toBe("x.flac");
	});

	it("normalizes Windows separators", () => {
		expect(toObjectKey("music\\Artist\\Album\\T.flac")).toBe("music/Artist/Album/T.flac");
	});

	it("collapses repeated slashes (was: 'Vercel Blob: pathname cannot contain \"//\"' on progressive-stream persist)", () => {
		// downloadLocation defaults to "music/" and generatePath appends "/<album>".
		expect(toObjectKey("music//Album/CD1/T.flac")).toBe("music/Album/CD1/T.flac");
		expect(toObjectKey("music\\\\A//B///T.mp3")).toBe("music/A/B/T.mp3");
	});

	it("leaves an already-relative pathname untouched", () => {
		expect(toObjectKey("music/A - B/01 - T.mp3")).toBe("music/A - B/01 - T.mp3");
	});
});

describe("inferContentType", () => {
	it.each([
		["a.flac", "audio/flac"],
		["a.mp4", "audio/mp4"],
		["tracks/1/15.mp4", "audio/mp4"],
		["stories/u1/r1.mp4", "video/mp4"],
		["/stories/u1/r1.mp4", "video/mp4"],
		["a.mp3", "audio/mpeg"],
		["cover.JPG", "image/jpeg"],
		["cover.jpeg", "image/jpeg"],
		["cover.png", "image/png"],
		["noext", "audio/mpeg"],
	])("%s → %s", (path, type) => {
		expect(inferContentType(path)).toBe(type);
	});
});

describe("storage error guards", () => {
	it("recognizes StorageNotFoundError only", () => {
		const e = new StorageNotFoundError("music/x.mp3");
		expect(isStorageNotFound(e)).toBe(true);
		expect(isStorageUnavailable(e)).toBe(false);
		expect(e.name).toBe("NotFound");
		expect(e.message).toContain("music/x.mp3");
	});

	it("recognizes StorageUnavailableError only and keeps the cause", () => {
		const cause = new Error("503");
		const e = new StorageUnavailableError(cause);
		expect(isStorageUnavailable(e)).toBe(true);
		expect(isStorageNotFound(e)).toBe(false);
		expect(e.cause).toBe(cause);
	});

	it("rejects look-alike errors (was: routes matched on e.name === 'NotFound')", () => {
		const fake = Object.assign(new Error("x"), { name: "NotFound" });
		expect(isStorageNotFound(fake)).toBe(false);
		expect(isStorageUnavailable(null)).toBe(false);
	});
});

describe("trackObjectKey (C9)", () => {
	it("is unique per track and bitrate (was: music/{artist} - {title}.mp3, shared by every version and by MP3 128 vs 320)", () => {
		expect(trackObjectKey("3135556", 1)).toBe("tracks/3135556/1.mp3");
		expect(trackObjectKey(3135556, 3)).toBe("tracks/3135556/3.mp3");
		expect(trackObjectKey("3135556", 9)).toBe("tracks/3135556/9.flac");
		expect(trackObjectKey("3135556", 15)).toBe("tracks/3135556/15.mp4");
		expect(trackObjectKey("3135556", 8)).toBe("tracks/3135556/8.mp3");
		expect(trackObjectKey("3135556", 1)).not.toBe(trackObjectKey("3135557", 1));
		expect(trackObjectKey("3135556", 1).startsWith(TRACKS_PREFIX)).toBe(true);
	});

	it("refuses ids that are not Deezer track numbers", () => {
		expect(() => trackObjectKey("../x", 1)).toThrow(/invalid track id/);
		expect(() => trackObjectKey("-5", 1)).toThrow(/invalid track id/);
		expect(() => trackObjectKey("", 1)).toThrow(/invalid track id/);
	});

	it("maps every format to its extension", () => {
		expect(trackExtension(9)).toBe(".flac");
		expect(trackExtension(13)).toBe(".mp4");
		expect(trackExtension(0)).toBe(".mp3");
		expect(trackExtension(42)).toBe(".mp3");
	});
});
