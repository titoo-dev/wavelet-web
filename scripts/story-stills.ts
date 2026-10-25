// Writes the Theme Still of every Story Theme to a folder, to look at them.
//   npx tsx scripts/story-stills.ts [outDir] [coverUrl]
// Uses a sample Lyrics Range with Latin, Cyrillic and Greek lines; no database, no Deezer session.
import { mkdirSync, writeFileSync } from "fs";
import path from "path";
import { parseLyricsRange } from "../src/lib/story/range";
import { loadCover, renderStill } from "../src/lib/story/still";
import { STORY_THEMES } from "../src/lib/story/themes";

const outDir = process.argv[2] ?? "story-stills";
const coverUrl = process.argv[3] ?? "https://cdn-images.dzcdn.net/images/cover/2e018122cb56986277102d2041a592c8/1000x1000-000000-80-0-0.jpg";

async function main() {
	const parsed = parseLyricsRange({
		lines: [
			{ timeMs: 60_000, text: "Like the legend of the phoenix" },
			{ timeMs: 63_600, text: "All ends with beginnings" },
			{ timeMs: 67_100, text: "Ce qu'on garde pour soi finit toujours par se dire un soir" },
			{ timeMs: 71_000, text: "Ничего не говори" },
			{ timeMs: 74_500, text: "Αγάπη μου" },
		],
		nextLineMs: 78_000,
		trackDurationMs: 248_000,
	});
	if (!parsed.ok) throw new Error(parsed.message);
	const cover = await loadCover(coverUrl);
	mkdirSync(outDir, { recursive: true });
	for (const theme of STORY_THEMES) {
		const started = performance.now();
		const jpeg = await renderStill({ range: parsed.range, theme, title: "Get Lucky (feat. Pharrell Williams & Nile Rodgers)", artist: "Daft Punk", cover });
		const file = path.join(outDir, `${theme}.jpg`);
		writeFileSync(file, jpeg);
		console.log(`${file}  ${(jpeg.length / 1024).toFixed(0)} KB  ${Math.round(performance.now() - started)} ms`);
	}
	if (!cover) console.warn("(cover not loaded: stills drawn without it)");
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
