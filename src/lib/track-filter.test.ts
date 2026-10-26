import { describe, expect, it } from "vitest";
import { foldText, trackMatcher } from "./track-filter";

const tracks = [
	{ title: "Crazy in Love", artist: "Beyoncé", album: "Dangerously in Love" },
	{ title: "Halo", artist: "Beyoncé", album: "I Am... Sasha Fierce" },
	{ title: "Get Lucky", artist: "Daft Punk", album: "Random Access Memories" },
	{ title: "Été indien", artist: "Joe Dassin", album: null },
];
const titles = (q: string) => tracks.filter(trackMatcher(q)).map((t) => t.title);

describe("foldText", () => {
	it("drops case, accents and extra spaces", () => {
		expect(foldText("  Beyoncé   Knowles ")).toBe("beyonce knowles");
	});
});

describe("trackMatcher", () => {
	it("matches everything on a blank query", () => {
		expect(titles("   ")).toHaveLength(tracks.length);
	});

	it("searches title, artist and album, ignoring case and accents", () => {
		expect(titles("HALO")).toEqual(["Halo"]);
		expect(titles("beyonce")).toEqual(["Crazy in Love", "Halo"]);
		expect(titles("random access")).toEqual(["Get Lucky"]);
		expect(titles("ete")).toEqual(["Été indien"]);
	});

	it("needs every word, in any order and across fields", () => {
		expect(titles("love crazy")).toEqual(["Crazy in Love"]);
		expect(titles("daft lucky")).toEqual(["Get Lucky"]);
		expect(titles("daft halo")).toEqual([]);
	});
});
