// Fonts of the Lyrics Stories, read from assets/fonts/story (bundled with the routes through
// next.config `outputFileTracingIncludes`): Geist, and Noto Sans for Cyrillic and Greek.
import path from "path";
import { GlobalFonts } from "@napi-rs/canvas";

const FILES: [file: string, family: string][] = [
	["Geist-SemiBold.ttf", "Geist"],
	["Geist-Bold.ttf", "Geist"],
	["NotoSans_600SemiBold.ttf", "Noto Sans"],
	["NotoSans_700Bold.ttf", "Noto Sans"],
];

let registered = false;

/** Registers the story fonts once per process; throws when a font file is missing. */
export function registerStoryFonts(dir = path.join(process.cwd(), "assets/fonts/story")) {
	if (registered) return;
	for (const [file, family] of FILES) {
		if (!GlobalFonts.registerFromPath(path.join(dir, file), family)) {
			throw new Error(`Story font not found: ${file}`);
		}
	}
	registered = true;
}
