// Lyrics layout of a Lyrics Story, done once per render: wrap each line to the width and pick the
// largest font size at which no line needs more than MAX_ROWS rows. The text measure is injected,
// so this stays pure (the canvas measures in production, a fake in tests).

/** Width of `text` at `fontSize` px. */
export type Measure = (text: string, fontSize: number) => number;

export const MAX_ROWS = 3;

/** Greedy word wrap; a word wider than `maxWidth` on its own is split by characters. */
export function wrapText(text: string, maxWidth: number, fontSize: number, measure: Measure): string[] {
	if (!text) return [""];
	const rows: string[] = [];
	let row = "";
	const pushWord = (word: string) => {
		if (measure(word, fontSize) <= maxWidth) return [word];
		const parts: string[] = [];
		let part = "";
		for (const ch of Array.from(word)) {
			if (part && measure(part + ch, fontSize) > maxWidth) {
				parts.push(part);
				part = ch;
			} else part += ch;
		}
		if (part) parts.push(part);
		return parts;
	};
	for (const word of text.split(" ")) {
		const candidate = row ? `${row} ${word}` : word;
		if (measure(candidate, fontSize) <= maxWidth) {
			row = candidate;
			continue;
		}
		if (row) rows.push(row);
		const pieces = pushWord(word);
		rows.push(...pieces.slice(0, -1));
		row = pieces[pieces.length - 1];
	}
	if (row) rows.push(row);
	return rows;
}

export interface LyricsLayout {
	fontSize: number;
	/** The wrapped rows of each line, in line order. */
	rows: string[][];
}

/**
 * The largest of `sizes` (tried from first to last) at which every line wraps to at most MAX_ROWS
 * rows; the last size otherwise, with lines cut to MAX_ROWS rows and an ellipsis.
 */
export function layoutLyrics(texts: string[], maxWidth: number, sizes: number[], measure: Measure): LyricsLayout {
	for (const fontSize of sizes) {
		const rows = texts.map((t) => wrapText(t, maxWidth, fontSize, measure));
		if (rows.every((r) => r.length <= MAX_ROWS)) return { fontSize, rows };
	}
	const fontSize = sizes[sizes.length - 1];
	const rows = texts.map((t) => {
		const r = wrapText(t, maxWidth, fontSize, measure);
		if (r.length <= MAX_ROWS) return r;
		const kept = r.slice(0, MAX_ROWS);
		kept[MAX_ROWS - 1] = `${kept[MAX_ROWS - 1].replace(/\s*\S{0,3}$/, "")}…`;
		return kept;
	});
	return { fontSize, rows };
}

/** `text` cut with an ellipsis so it fits `maxWidth` on one row. */
export function ellipsize(text: string, maxWidth: number, fontSize: number, measure: Measure): string {
	if (measure(text, fontSize) <= maxWidth) return text;
	const chars = Array.from(text);
	while (chars.length && measure(`${chars.join("")}…`, fontSize) > maxWidth) chars.pop();
	return `${chars.join("").trimEnd()}…`;
}
