import type { Canvas, Image, SKRSContext2D } from "@napi-rs/canvas";
import type { CoverSeed } from "@/lib/cover-palette";
import type { LyricsRange } from "../range";
import type { LyricsLayout } from "../layout";

/** The Story Themes a listener can pick (CONTEXT.md), in the order the app shows them. */
export const STORY_THEMES = ["blurred-cover", "palette", "minimal", "vinyl"] as const;
export type StoryThemeId = (typeof STORY_THEMES)[number];

export function isStoryTheme(value: unknown): value is StoryThemeId {
	return typeof value === "string" && (STORY_THEMES as readonly string[]).includes(value);
}

/** Everything a Story Theme draws from. */
export interface StoryInput {
	range: LyricsRange;
	title: string;
	artist: string;
	/** The decoded cover, or null when it could not be loaded (themes then use the seed alone). */
	cover: Image | null;
	seed: CoverSeed;
	width: number;
	height: number;
}

/** What a theme works out once per render: the static layer and the lyrics layout. */
export interface PreparedStory {
	input: StoryInput;
	/** Everything that does not move, drawn once. */
	background: Canvas;
	layout: LyricsLayout;
}

export interface StoryTheme {
	id: StoryThemeId;
	prepare(input: StoryInput): PreparedStory;
	/** Draws the frame at `tMs` from the start of the excerpt. */
	draw(ctx: SKRSContext2D, story: PreparedStory, tMs: number): void;
}
