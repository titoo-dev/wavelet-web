import { describe, it, expect } from "vitest";
import { albumHref, artistHref, pickAlbumId, pickArtistId, primaryArtistName, trackRadioHref } from "./entity-links";

describe("artistHref", () => {
	it("links by Deezer id when there is one", () => {
		expect(artistHref("27", "Daft Punk")).toBe("/artist?id=27");
		expect(artistHref(27)).toBe("/artist?id=27");
	});

	it("falls back to the name when the id is missing (library rows only store the name)", () => {
		expect(artistHref(null, "Daft Punk")).toBe("/artist?name=Daft%20Punk");
		expect(artistHref("", " Bigflo & Oli ")).toBe("/artist?name=Bigflo%20%26%20Oli");
		expect(artistHref("0", "Garou")).toBe("/artist?name=Garou");
	});

	it("returns null with neither id nor name", () => {
		expect(artistHref(undefined, "  ")).toBeNull();
		expect(artistHref(null)).toBeNull();
	});
});

describe("albumHref", () => {
	it("links by id when there is one", () => {
		expect(albumHref("302127", "Discovery")).toBe("/album?id=302127");
		expect(albumHref(5)).toBe("/album?id=5");
	});

	it("falls back to title + lead artist when the id is missing (shares, Spotify imports)", () => {
		expect(albumHref(null, "Discovery", "Daft Punk")).toBe("/album?title=Discovery&artist=Daft%20Punk");
		expect(albumHref("", "Levitating", "Dua Lipa, DaBaby")).toBe("/album?title=Levitating&artist=Dua%20Lipa");
		expect(albumHref(0, "Random Access Memories")).toBe("/album?title=Random%20Access%20Memories");
	});

	it("returns null with neither id nor title", () => {
		expect(albumHref(null)).toBeNull();
		expect(albumHref("", " ")).toBeNull();
	});
});

describe("primaryArtistName", () => {
	it("keeps the lead artist of a credit line", () => {
		expect(primaryArtistName("Dua Lipa, DaBaby")).toBe("Dua Lipa");
		expect(primaryArtistName("Drake feat. Rihanna")).toBe("Drake");
		expect(primaryArtistName("Drake ft Rihanna")).toBe("Drake");
		expect(primaryArtistName("Calvin Harris (feat. Rihanna)")).toBe("Calvin Harris");
		expect(primaryArtistName("Simon & Garfunkel")).toBe("Simon & Garfunkel");
	});
});

describe("pickArtistId", () => {
	const results = [
		{ id: 1, name: "Nirvana (UK)" },
		{ id: 2, name: "Beyoncé" },
		{ id: 3, name: "Dua Lipa" },
	];

	it("prefers an exact accent- and case-insensitive match", () => {
		expect(pickArtistId("beyonce", results)).toBe("2");
	});

	it("matches the primary artist of a credit line", () => {
		expect(pickArtistId("Dua Lipa, DaBaby", results)).toBe("3");
	});

	it("matches a name Deezer disambiguates with a suffix", () => {
		expect(pickArtistId("Nirvana", results)).toBe("1");
	});

	it("finds nothing rather than an unrelated artist (NAV-23, was: opened Deezer's top result)", () => {
		expect(pickArtistId("Lumière", results)).toBeNull();
	});

	it("returns null with no usable result", () => {
		expect(pickArtistId("x", [])).toBeNull();
		expect(pickArtistId("x", [{ id: null, name: "x" }])).toBeNull();
	});
});

describe("pickAlbumId", () => {
	const results = [
		{ id: 1, title: "Discovery (Live)", artist: { name: "Daft Punk" } },
		{ id: 2, title: "Discovery", artist: { name: "Someone Else" } },
		{ id: 3, title: "Discovery", artist: { name: "Daft Punk" } },
		{ id: 4, title: "Homework", artist: { name: "Daft Punk" } },
	];

	it("prefers the same title by the same artist", () => {
		expect(pickAlbumId("discovery", "Daft Punk", results)).toBe("3");
	});

	it("takes the same title when no artist is known", () => {
		expect(pickAlbumId("Discovery", null, results)).toBe("2");
	});

	it("finds nothing rather than another album (NAV-23, was: another artist's album or the top result)", () => {
		expect(pickAlbumId("Alive 2007", "Daft Punk", results)).toBeNull();
		expect(pickAlbumId("Alive 2007", "Nobody", results)).toBeNull();
		expect(pickAlbumId("Discovery", "Nobody", results)).toBeNull();
	});

	it("accepts an edition suffix on the title by the same artist", () => {
		expect(pickAlbumId("Random Access Memories", "Daft Punk", [{ id: 9, title: "Random Access Memories (10th Anniversary Edition)", artist: { name: "Daft Punk" } }])).toBe("9");
	});

	it("returns null with no usable result", () => {
		expect(pickAlbumId("x", "y", [])).toBeNull();
	});
});

describe("trackRadioHref", () => {
	it("links a catalogue Deezer track to its song radio", () => {
		expect(trackRadioHref("3135556")).toBe("/radio?track=3135556");
		expect(trackRadioHref(42)).toBe("/radio?track=42");
	});

	it("has no radio for user uploads (negative ids), 0 or no id", () => {
		expect(trackRadioHref("-12345")).toBeNull();
		expect(trackRadioHref("0")).toBeNull();
		expect(trackRadioHref("")).toBeNull();
		expect(trackRadioHref(null)).toBeNull();
	});
});
