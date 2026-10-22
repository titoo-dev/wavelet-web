// Live check of the similar-track sources (no ARL needed: Deezer's public API).
// npx tsx scripts/smoke-similar.ts [deezerTrackId…]   (LASTFM_API_KEY in .env for Last.fm)
// Prints each source's tracks once resolved on Deezer; exits 1 when no source gave anything.
import "dotenv/config";
import { CookieJar } from "tough-cookie";
import { API } from "@/lib/deezer/api";
import { similarLists } from "@/lib/similar";

const ids = process.argv.slice(2);
const api = new API(new CookieJar(), { "User-Agent": "Wavelet smoke" });
async function main() {
	const t0 = Date.now();
	const lists = await similarLists(api, ids.length ? ids : ["3135556"]);
	console.log(`${lists.length} non-empty lists in ${Date.now() - t0} ms (Last.fm ${process.env.LASTFM_API_KEY ? "on" : "off: no LASTFM_API_KEY"})`);
	for (const [i, l] of lists.entries()) {
		console.log(`\nlist ${i + 1}: ${l.length} tracks`);
		for (const t of l) console.log(`  ${t.trackId}  ${t.artist} — ${t.title}`);
	}
	process.exit(lists.length ? 0 : 1);
}

void main();
