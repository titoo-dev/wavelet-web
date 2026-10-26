import { describe, expect, it } from "vitest";
import {
	albumRows,
	compactNumber,
	formatReleaseDate,
	formatTotal,
	htmlToText,
	parseAlbumPage,
	parseArtistPage,
	parsePlaylistPage,
	plural,
	recordTypeLabel,
	releaseFromRaw,
	trackCovers,
} from "./collection-page";

describe("formatting", () => {
	it("pluralises", () => {
		expect(plural(1, "track")).toBe("1 track");
		expect(plural(0, "track")).toBe("0 tracks");
		expect(plural(1200, "fan")).toBe("1,200 fans");
	});

	it("formats compact counts", () => {
		expect(compactNumber(249562)).toBe("249.6K");
		expect(compactNumber(812)).toBe("812");
	});

	it("formats total running time", () => {
		expect(formatTotal(20)).toBe("1 min");
		expect(formatTotal(42 * 60)).toBe("42 min");
		expect(formatTotal(3824)).toBe("1 hr 4 min");
		expect(formatTotal(7200)).toBe("2 hr");
	});

	it("formats release dates in UTC", () => {
		expect(formatReleaseDate("2013-05-17")).toBe("May 17, 2013");
		expect(formatReleaseDate("soon")).toBe("soon");
	});

	it("turns bio HTML into text with paragraphs and entities", () => {
		expect(htmlToText("<p>Born in &quot;Reykjav&#237;k&quot;</p><p>Jazz &amp; pop<br/>since 2020</p>")).toBe('Born in "Reykjavík"\n\nJazz & pop\nsince 2020');
		expect(htmlToText("&#x41;&bogus;")).toBe("A&bogus;");
	});

	it("maps GW types and API record types", () => {
		expect(recordTypeLabel("0")).toBe("Single");
		expect(recordTypeLabel(1)).toBe("Album");
		expect(recordTypeLabel("compile")).toBe("Compilation");
		expect(recordTypeLabel("ep")).toBe("EP");
		expect(recordTypeLabel("3")).toBe("EP");
		expect(recordTypeLabel(undefined)).toBeNull();
	});

	it("dedupes track covers", () => {
		expect(trackCovers(["a", null, "a", "b", undefined], 1)).toEqual(["a"]);
	});
});

describe("releaseFromRaw", () => {
	it("reads public API albums", () => {
		expect(releaseFromRaw({ id: "9", title: "T", cover_big: "big", release_date: "2024-12-06", record_type: "single", nb_tracks: 3 })).toEqual({
			id: "9",
			title: "T",
			cover: "big",
			year: "2024",
			recordType: "Single",
			trackCount: 3,
		});
	});

	it("reads GW albums and ignores 0000 dates", () => {
		const r = releaseFromRaw({ ALB_ID: "5", ALB_TITLE: "G", ALB_PICTURE: "md5", ORIGINAL_RELEASE_DATE: "0000-00-00", TYPE: "1" });
		expect(r?.cover).toBe("https://e-cdns-images.dzcdn.net/images/cover/md5/500x500-000000-80-0-0.jpg");
		expect(r?.year).toBeNull();
		expect(r?.recordType).toBe("Album");
	});

	it("drops albums without an id", () => {
		expect(releaseFromRaw({ title: "x" })).toBeNull();
		expect(releaseFromRaw(null)).toBeNull();
	});
});

describe("parseAlbumPage", () => {
	const gw = {
		DATA: {
			ALB_ID: "438167857",
			ALB_TITLE: "Random Access Memories",
			ART_ID: "27",
			ART_NAME: "Daft Punk",
			ARTISTS: [{ ART_ID: "27", ART_PICTURE: "pic" }],
			ALB_PICTURE: "cov",
			ORIGINAL_RELEASE_DATE: "2013-05-17",
			LABEL_NAME: "Columbia",
			COPYRIGHT: "",
			DURATION: "6601",
		},
		ALBUMS: {
			data: [
				{ ALB_ID: "438167857", ALB_TITLE: "Random Access Memories", TYPE: "1" },
				{ ALB_ID: "1", ALB_TITLE: "Discovery", TYPE: "1", ORIGINAL_RELEASE_DATE: "2001-03-12" },
				{ ALB_ID: "1", ALB_TITLE: "Discovery (dup)" },
			],
		},
		tracks: [
			{ SNG_ID: "a", DISK_NUMBER: "1", DURATION: "10" },
			{ SNG_ID: "b", DISK_NUMBER: "1" },
			{ SNG_ID: "c", DISK_NUMBER: "2" },
		],
	};

	it("parses the GW album page", () => {
		const p = parseAlbumPage(gw)!;
		expect(p.id).toBe("438167857");
		expect(p.artist).toBe("Daft Punk");
		expect(p.artistId).toBe("27");
		expect(p.artistPicture).toBe("https://e-cdns-images.dzcdn.net/images/artist/pic/250x250-000000-80-0-0.jpg");
		expect(p.cover).toContain("/cover/cov/500x500");
		expect(p.recordType).toBe("Album"); // found itself in ALBUMS
		expect(p.year).toBe("2013");
		expect(p.label).toBe("Columbia");
		expect(p.copyright).toBeNull(); // empty strings drop out
		expect(p.duration).toBe(6601);
		expect(p.discs).toEqual([1, 1, 2]);
		expect(p.discCount).toBe(2);
		expect(p.moreByArtist.map((a) => a.title)).toEqual(["Discovery"]);
	});

	it("falls back to summed track durations and the compilation subtype", () => {
		const p = parseAlbumPage({ DATA: { ALB_TITLE: "Mix", SUBTYPES: { isCompilation: true } }, SONGS: { data: [{ DURATION: "60" }, { duration: 30 }] } }, "77")!;
		expect(p.id).toBe("77");
		expect(p.duration).toBe(90);
		expect(p.recordType).toBe("Compilation");
		expect(p.discCount).toBe(1);
		expect(p.releaseDate).toBeNull();
	});

	it("reads public API albums", () => {
		const p = parseAlbumPage({ id: 3, title: "T", artist: { id: 9, name: "A", picture_medium: "pm" }, cover_xl: "xl", record_type: "ep", release_date: "2020-01-01", label: "L" })!;
		expect(p.artistPicture).toBe("pm");
		expect(p.cover).toBe("xl");
		expect(p.recordType).toBe("EP");
		expect(p.label).toBe("L");
		expect(p.duration).toBeNull();
	});

	it("returns null without a title", () => {
		expect(parseAlbumPage({ DATA: {} })).toBeNull();
		expect(parseAlbumPage(undefined)).toBeNull();
	});
});

describe("albumRows", () => {
	it("interleaves disc headers only for multi-disc albums", () => {
		expect(albumRows([1, 1])).toEqual([
			{ kind: "track", index: 0 },
			{ kind: "track", index: 1 },
		]);
		expect(albumRows([1, 2, 2])).toEqual([
			{ kind: "disc", disc: 1 },
			{ kind: "track", index: 0 },
			{ kind: "disc", disc: 2 },
			{ kind: "track", index: 1 },
			{ kind: "track", index: 2 },
		]);
	});

	it("keeps only the searched tracks, and the headers of their discs", () => {
		expect(albumRows([1, 1, 2, 2], (i) => i === 3)).toEqual([
			{ kind: "disc", disc: 2 },
			{ kind: "track", index: 3 },
		]);
		expect(albumRows([1, 2], () => false)).toEqual([]);
	});
});

describe("parseArtistPage", () => {
	const gw = {
		DATA: { ART_ID: "12369444", ART_NAME: "Laufey", ART_PICTURE: "p", NB_FAN: 249562 },
		BIO: { BIO: "<p>Born in Reykjavík.</p>", RESUME: "" },
		RELATED_ARTISTS: { data: [{ ART_ID: "1", ART_NAME: "beabadoobee", ART_PICTURE: "b", NB_FAN: 209382 }, { ART_ID: "2" }] },
		topTracks: [{ SNG_ID: "t1" }],
		discography: {
			single: [{ id: "s1", title: "S", cover_medium: "c2", record_type: "single" }],
			all: [
				{ id: "a1", title: "A", cover_big: "c1" },
				{ id: "s1", title: "S", cover_medium: "c2" },
			],
			more: [],
			live: [{ id: "l1", title: "L" }],
			album: [{ id: "a1", title: "A", cover_big: "c1" }],
		},
	};

	it("parses the GW artist page", () => {
		const p = parseArtistPage(gw)!;
		expect(p.name).toBe("Laufey");
		expect(p.picture).toBe("https://e-cdns-images.dzcdn.net/images/artist/p/500x500-000000-80-0-0.jpg");
		expect(p.fans).toBe(249562);
		expect(p.bio).toBe("Born in Reykjavík.");
		expect(p.topTracks).toHaveLength(1);
		expect(p.tabs.map((t) => `${t.key}:${t.label}:${t.releases.length}`)).toEqual(["all:All:2", "album:Albums:1", "single:Singles:1", "live:Live:1"]);
		expect(p.albumCount).toBe(1);
		expect(p.covers).toEqual(["c1", "c2"]);
		expect(p.related).toEqual([{ id: "1", name: "beabadoobee", picture: "https://e-cdns-images.dzcdn.net/images/artist/b/250x250-000000-80-0-0.jpg", fans: 209382 }]);
	});

	it("falls back to TOP, string bios and public API fields", () => {
		const p = parseArtistPage({ name: "X", id: 4, picture_xl: "px", nb_fan: "10", bio: "Hi", TOP: { data: [{}, {}] } }, "4")!;
		expect(p.id).toBe("4");
		expect(p.picture).toBe("px");
		expect(p.fans).toBe(10);
		expect(p.bio).toBe("Hi");
		expect(p.topTracks).toHaveLength(2);
		expect(p.tabs).toEqual([]);
		expect(p.albumCount).toBeNull();
		expect(p.related).toEqual([]);
	});

	it("returns null without a name", () => {
		expect(parseArtistPage({ DATA: { ART_ID: "1" } })).toBeNull();
	});
});

describe("parsePlaylistPage", () => {
	it("parses the GW playlist page (creator, playlist picture kind, description)", () => {
		const p = parsePlaylistPage({
			DATA: {
				PLAYLIST_ID: "1306085715",
				TITLE: "lofi hip-hop",
				PARENT_USERNAME: "Ayoub",
				DESCRIPTION: "Chill &amp; study",
				PLAYLIST_PICTURE: "pp",
				PICTURE_TYPE: "playlist",
				NB_FAN: 35251,
				DURATION: 14008,
			},
			tracks: [{}, {}],
		})!;
		expect(p.id).toBe("1306085715");
		expect(p.creator).toBe("Ayoub");
		expect(p.description).toBe("Chill & study");
		expect(p.cover).toBe("https://e-cdns-images.dzcdn.net/images/playlist/pp/500x500-000000-80-0-0.jpg");
		expect(p.fans).toBe(35251);
		expect(p.duration).toBe(14008);
		expect(p.tracks).toHaveLength(2);
	});

	it("reads public API playlists and sums durations", () => {
		const p = parsePlaylistPage({ title: "Mix", creator: { name: "Me" }, picture_xl: "x", SONGS: { data: [{ duration: 100 }, { DURATION: "20" }] } }, "9")!;
		expect(p.id).toBe("9");
		expect(p.creator).toBe("Me");
		expect(p.cover).toBe("x");
		expect(p.description).toBeNull();
		expect(p.duration).toBe(120);
	});

	it("returns null without a title", () => {
		expect(parsePlaylistPage({})).toBeNull();
	});
});
