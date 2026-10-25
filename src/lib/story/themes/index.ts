import { blurredCover } from "./blurred-cover";
import { minimal } from "./minimal";
import { palette } from "./palette";
import { vinyl } from "./vinyl";
import type { StoryTheme, StoryThemeId } from "./types";

export { STORY_THEMES, isStoryTheme } from "./types";
export type { StoryTheme, StoryThemeId, StoryInput, PreparedStory } from "./types";

export const THEMES: Record<StoryThemeId, StoryTheme> = {
	"blurred-cover": blurredCover,
	palette,
	minimal,
	vinyl,
};
