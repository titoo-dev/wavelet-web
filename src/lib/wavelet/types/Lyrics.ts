import { decode } from "html-entities";
import type { GWLyrics } from "@/lib/deezer/gw";

export class Lyrics {
	id: string;
	sync: string;
	unsync: string;
	/** [line, start in ms] pairs for the ID3 SYLT frame. */
	syncID3: [string, number][];

	constructor(lyr_id = "0") {
		this.id = lyr_id;
		this.sync = "";
		this.unsync = "";
		this.syncID3 = [];
	}

	parseLyrics(lyricsAPI: GWLyrics) {
		if (!lyricsAPI || typeof lyricsAPI !== "object") return;
		this.unsync = lyricsAPI.LYRICS_TEXT || "";
		if (lyricsAPI.LYRICS_SYNC_JSON) {
			const syncLyricsJson = lyricsAPI.LYRICS_SYNC_JSON;
			let timestamp = "";
			let milliseconds = 0;
			for (let line = 0; line < syncLyricsJson.length; line++) {
				const currentLine = decode(syncLyricsJson[line].line);
				if (currentLine !== "") {
					timestamp = syncLyricsJson[line].lrc_timestamp;
					milliseconds = parseInt(syncLyricsJson[line].milliseconds);
					this.syncID3.push([currentLine, milliseconds]);
				} else {
					let notEmptyLine = line + 1;
					while (
						notEmptyLine < syncLyricsJson.length &&
						syncLyricsJson[notEmptyLine].line === ""
					)
						notEmptyLine += 1;
					if (notEmptyLine < syncLyricsJson.length) {
						timestamp = syncLyricsJson[notEmptyLine].lrc_timestamp;
					}
				}
				this.sync += timestamp + currentLine + "\n";
			}
		}
	}

	generateLrcHeader(track: { title: string; mainArtist: { name: string }; album: { title: string }; duration: number }) {
		const lines: string[] = [];
		if (track.title) lines.push(`[ti:${track.title}]`);
		if (track.mainArtist?.name) lines.push(`[ar:${track.mainArtist.name}]`);
		if (track.album?.title) lines.push(`[al:${track.album.title}]`);
		if (track.duration) {
			const min = Math.floor(track.duration / 60);
			const sec = String(track.duration % 60).padStart(2, "0");
			lines.push(`[length:${min}:${sec}]`);
		}
		return lines.length > 0 ? lines.join("\n") + "\n" : "";
	}
}
