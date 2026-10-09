// Critical web flows end to end, in headless Chrome against the local stack.
// Run through `npm run e2e` (e2e/run.mjs); see e2e/README.md.
import { openPage, sleep, until } from "./lib/cdp.mjs";
import { apiClient } from "./lib/stack.mjs";

// Deezer album 302127 = Daft Punk "Discovery".
const ALBUM = "302127";
const ONE_MORE_TIME = "3135553";

export async function runCriticalFlows({ browser, base, cookie, db, cronSecret, check }) {
	const api = apiClient(base, cookie);
	const p = await openPage(browser, { base, cookie });
	let anon = null;
	let a;
	const playing = (min = 0.5) =>
		until(async () => {
			const x = await p.active();
			return x && x.t > min ? x : null;
		}, 25000);

	// F0 — auth guard
	check("F0 auth", "API refuses a request without session (401)", (await api("GET", "/api/v1/library/tracks", null, { auth: false })).status === 401);
	check("F0 auth", "API accepts the session cookie", (await api("GET", "/api/v1/library/tracks")).status === 200);

	// F1 — home
	await p.goto("/", 4000);
	// The header stays a guest one until /auth/connect answers, and the first
	// call logs in to Deezer with the stored ARL (~7 s cold).
	const homeNav = await until(async () => {
		const l = await p.labels("^(Account|Library|Playlists)$");
		return new Set(l).size >= 3 ? l : null;
	}, 20000);
	check("F1 home", "home renders signed in (Account + nav)", !!homeNav, JSON.stringify(await p.labels("^(Account|Library|Playlists|Sign in)$")));

	// F2 — search
	const s = await api("GET", "/api/v1/search?term=harder%20better%20faster&type=track&nb=5");
	check("F2 search", "search API returns tracks", s.status === 200 && JSON.stringify(s.json).includes("3135556"), s.status);
	await p.click("^Search and download \\(Command K\\)$");
	await sleep(800);
	await p.type("harder better faster stronger");
	const opts = await until(async () => {
		const o = await p.ev(`[...document.querySelectorAll("[role=option],[cmdk-item]")].map(e=>e.textContent.trim().slice(0,60))`);
		return o.some((x) => /harder/i.test(x)) ? o : null;
	});
	check("F2 search", "⌘K palette lists matching results", !!opts, JSON.stringify(opts)?.slice(0, 200));
	await p.key("Escape");
	await sleep(500);

	// F3 — album page
	await p.goto(`/album?id=${ALBUM}`, 4000);
	const trackButtons = (await p.labels("^Play ")).filter((l) => !/album|Random|Homework|TRON|Alive/.test(l));
	check("F3 album", "album page lists its tracks", trackButtons.length >= 13, trackButtons.length);

	// F4 — first play (uncached → live progressive stream)
	check("F4 play", "Play album clicked", !!(await p.click("^Play album$")));
	a = await playing();
	check("F4 play", "first play starts", !!a, JSON.stringify(await p.audio()));
	check("F4 play", "first play is the live progressive stream", /stream-progressive\/3135553/.test(a?.src || ""), a?.src);

	// F5 — seek far ahead on the live stream, like a user: click the seek bar at ~200 s
	const bar = await p.seekBarTo(200);
	a = await until(async () => {
		const x = await p.active();
		return x && x.t >= 190 && x.t < 230 ? x : null;
	}, 20000);
	check("F5 seek", "seek bar click at ~200 s lands there on the live stream", !!bar && !!a, `${JSON.stringify(bar)} ${JSON.stringify(await p.audio())}`);

	// F6 — next / previous
	check("F6 nav", "Next track clicked", !!(await p.click("^Next track$")));
	a = await until(async () => {
		const x = await p.active();
		return x && x.t > 0.3 && /Aerodynamic/i.test((await p.nowPlaying()) || "") ? x : null;
	}, 25000);
	check("F6 nav", "next track (Aerodynamic) plays", !!a, JSON.stringify(await p.audio()).slice(-300));
	check("F6 nav", "Previous track clicked", !!(await p.click("^Previous track$")));
	a = await until(async () => {
		const x = await p.active();
		return x && /One More Time/i.test((await p.nowPlaying()) || "") ? x : null;
	}, 20000);
	check("F6 nav", "previous track (One More Time) plays again", !!a, JSON.stringify(await p.audio()).slice(-300));

	// F7 — pause / resume through the UI
	check("F7 pause", "Pause clicked", !!(await p.click("^Pause$")));
	await sleep(1200);
	check("F7 pause", "audio paused", !(await p.active()));
	check("F7 pause", "Play (resume) clicked", !!(await p.click("^Play$")));
	check("F7 pause", "audio resumed", !!(await until(() => p.active(), 8000)));

	// F8 — queue panel, F10 lyrics, F9 fullscreen
	check("F8 queue", "Open queue clicked", !!(await p.click("^Open queue$")));
	const q = await until(() => p.ev(`/up next/i.test(document.body.innerText) && /now playing/i.test(document.body.innerText)`), 6000);
	check("F8 queue", "queue panel shows Now Playing / Up Next", !!q);
	await p.key("Escape");
	await sleep(600);
	check("F10 lyrics", "Toggle lyrics clicked", !!(await p.click("^Toggle lyrics$")));
	// /api/* goes through the app's service worker, so the page's CDP Network
	// events never carry these responses: read them from Resource Timing.
	const lyr = await until(async () => {
		const l = await p.ev(`performance.getEntriesByType("resource").filter(e=>/\\/api\\/v1\\/lyrics\\//.test(e.name)&&e.responseStatus).map(e=>[e.name.replace(location.origin,"").slice(0,40),e.responseStatus])`);
		return l?.length ? l : null;
	}, 10000);
	const lyrOpen = (await p.labels("^Close lyrics$")).length > 0;
	const lyrShown = await until(() => p.ev(`/LYRICS/.test(document.body.innerText) && !/No lyrics available|Failed to fetch lyrics/.test(document.body.innerText)`), 8000);
	check("F10 lyrics", "lyrics panel opens, lyrics fetched without server error", lyrOpen && !!lyr && lyr.every(([, s]) => s < 500) && !!lyrShown, `${lyrOpen} ${!!lyrShown} ${JSON.stringify(lyr)}`);
	await p.click("^Close lyrics$", { tries: 3 });
	await sleep(600);
	check("F9 fullscreen", "Open fullscreen player clicked", !!(await p.click("^Open fullscreen player$")));
	check("F9 fullscreen", "fullscreen player opens", !!(await until(() => p.ev(`!!document.querySelector("[role=dialog],[aria-modal=true]")`), 6000)));
	await p.key("Escape");
	await sleep(800);
	if (await p.ev(`!!document.querySelector("[aria-modal=true]")`)) await p.click("^(Close|Minimize|Collapse).*", { tries: 3 });

	// F11 — the first play is persisted; F12 — a recent play after 30 s really listened
	const row = await until(async () => (await db.query(`SELECT "storagePath" FROM stored_track WHERE "trackId"=$1`, [ONE_MORE_TIME]))[0]?.storagePath, 60000, 1000);
	check("F11 persist", "first play persisted under tracks/{id}/{bitrate}", /^tracks\/3135553\/1\.mp3$/.test(row || ""), row);
	console.log("         listening 32 s for the recent-play rule…");
	await sleep(32000);
	const rp = await until(async () => JSON.stringify((await api("GET", "/api/v1/recent-plays")).json).includes(ONE_MORE_TIME));
	check("F12 recent", "track logged as a recent play after 30 s listened", !!rp);

	// F13 — a refresh resumes where it was
	const before = (await p.active())?.t ?? 0;
	await p.click("^Pause$");
	await sleep(1200);
	await p.S("Page.reload");
	await sleep(4500);
	await p.click("^Play$");
	a = await playing(1);
	check("F13 resume", "refresh resumes near the saved position", !!a && Math.abs(a.t - before) < 15, `before=${before} after=${a?.t}`);
	await p.click("^Pause$");
	await sleep(800);

	// F14 — library: save album + liked track
	await p.goto(`/album?id=${ALBUM}`, 4000);
	check("F14 library", "Save album clicked", !!(await p.click("^Save album$")));
	check("F14 library", "album saved in the library", !!(await until(async () => JSON.stringify((await api("GET", "/api/v1/library/albums")).json).includes(ALBUM), 10000)));
	check("F14 library", "Save track clicked", !!(await p.click("^Save to library$")));
	check("F14 library", "track saved (liked)", !!(await until(async () => ((await api("GET", "/api/v1/library/tracks")).json?.data?.items || []).length > 0, 10000)));
	await p.goto("/library", 4000);
	const libText = await p.ev("document.body.innerText");
	check("F14 library", "library page shows the saved album and track", /1\s*liked/i.test(libText) && /1\s*albums?/i.test(libText), libText.slice(0, 200));

	// F15 — playlists
	const pl = await api("POST", "/api/v1/playlists", { title: "E2E critical", description: "auto" });
	const plId = pl.json?.data?.id || pl.json?.data?.playlist?.id;
	check("F15 playlist", "create playlist", (pl.status === 201 || pl.status === 200) && !!plId, pl.text.slice(0, 200));
	const add = await api("POST", `/api/v1/playlists/${plId}/tracks`, {
		tracks: [
			{ trackId: "3135556", title: "Harder, Better, Faster, Stronger", artist: "Daft Punk", album: "Discovery", duration: 224 },
			{ trackId: "3135557", title: "Crescendolls", artist: "Daft Punk", album: "Discovery", duration: 211 },
		],
	});
	check("F15 playlist", "add two tracks", add.status < 300, add.text.slice(0, 200));
	const reorder = await api("PATCH", `/api/v1/playlists/${plId}/tracks`, { trackIds: ["3135557", "3135556"] });
	check("F15 playlist", "reorder tracks", reorder.status < 300, reorder.text.slice(0, 200));
	await p.goto(`/my-playlists/${plId}`, 4000);
	const plText = await p.ev("document.body.innerText");
	check("F15 playlist", "playlist page shows its tracks", /E2E critical/.test(plText) && /Harder, Better/.test(plText), plText.slice(0, 200));
	const playPl = await p.click("^(Play|Play all|Play playlist)$");
	a = await playing(0.3);
	const np = await until(async () => /Crescendolls/i.test((await p.nowPlaying()) || ""), 10000);
	check("F15 playlist", "playing the playlist starts its first track (after reorder)", !!playPl && !!a && !!np && a.t < 30, `${playPl} ${await p.nowPlaying()} ${JSON.stringify(a)}`);
	await p.click("^Pause$");
	check("F15 playlist", "delete playlist", (await api("DELETE", `/api/v1/playlists/${plId}`)).status < 300);

	// F16 — public share links, signed out (cached copy + the owner's live fallback)
	const shareId = (await api("POST", "/api/v1/shares", { trackId: ONE_MORE_TIME, title: "One More Time", artist: "Daft Punk" })).json?.data?.shareId;
	check("F16 share", "create share link", !!shareId);
	const shareId2 = (await api("POST", "/api/v1/shares", { trackId: "3135561", title: "Superheroes", artist: "Daft Punk" })).json?.data?.shareId;
	anon = await openPage(browser, { base, cookie: null });
	for (const [id, label] of [
		[shareId, "cached copy"],
		[shareId2, "uncached → owner's live fallback"],
	]) {
		await anon.goto(`/share/t/${id}`, 4000);
		const clicked = await anon.click("^(Play|Play track|Listen|Play .*)$");
		const sa = await until(async () => {
			const x = await anon.active();
			return x && x.t > 0.5 ? x : null;
		}, 25000);
		check("F16 share", `signed-out share page plays (${label})`, !!clicked && !!sa, `${clicked} ${JSON.stringify(await anon.audio())}`);
		await anon.ev(`window.__audios.forEach(a=>a.pause())`);
	}
	const plays = (await db.query(`SELECT plays FROM shared_track WHERE "shareId"=$1`, [shareId]))[0]?.plays;
	check("F16 share", "share play counter incremented once", plays === 1, plays);
	await anon.closeTab();
	// A background tab freezes animations and timers: bring the main page back.
	await p.front();
	await sleep(500);

	// F17 — download a track file
	await p.goto(`/album?id=${ALBUM}`, 4000);
	const dlClicked = await p.clickJs("^Download One More Time$", { selector: "button" });
	// Headless Chrome stalls the final blob write to disk, so check what the app
	// hands the browser: an audio blob of the whole file saved under the track name.
	const saved = await until(async () => {
		const st = await p.ev(`({ blobs: window.__blobs, saves: window.__saves })`);
		return st.saves.length ? st : null;
	}, 60000, 1000);
	const blob = saved?.blobs.at(-1);
	check("F17 download", "track download produces an audio file (blob + filename)", !!dlClicked && !!blob && blob.size > 1_000_000 && /audio/.test(blob.type) && /One More Time\.(mp3|flac|m4a)$/i.test(saved.saves.at(-1)), `${dlClicked} ${JSON.stringify(saved)}`);

	// F18 — settings
	const q1 = await api("POST", "/api/v1/settings/quality", { maxBitrate: 3 });
	const q2 = await api("GET", "/api/v1/settings/quality");
	check("F18 settings", "change server quality (no admin list set)", q1.status === 200 && q2.json?.data?.maxBitrate === 3, `${q1.status} ${q2.text}`);
	await api("POST", "/api/v1/settings/quality", { maxBitrate: 1 });
	const st = await api("POST", "/api/v1/settings", { settings: { tags: {} } });
	check("F18 settings", "save user settings", st.status === 200, st.text.slice(0, 200));
	await p.goto("/settings", 5000);
	await p.click("^Dark$");
	check("F18 settings", "theme switch applies (dark)", !!(await until(() => p.ev(`document.documentElement.classList.contains("dark")`), 5000)));
	await p.click("^System$");

	// F19 — artist page
	await p.goto(`/album?id=${ALBUM}`, 4000);
	const artistClick = await p.clickJs("^Daft Punk$", { selector: 'a[href^="/artist"]' });
	await until(() => p.ev(`location.pathname.startsWith("/artist")`), 15000);
	await sleep(3000);
	check("F19 artist", "artist link opens the artist page", !!artistClick && /artist/.test(await p.ev("location.pathname")));
	const topPlay = await p.click("^Play ");
	a = await playing(0.3);
	check("F19 artist", "a top track plays from the artist page", !!topPlay && !!a, `${topPlay} ${JSON.stringify(a)}`);
	await p.click("^Pause$");

	// F20 — API contract / error paths
	const pf = await api("GET", "/api/v1/stream/9999999999?prefetch=1");
	check("F20 api", "/stream?prefetch=1 on an uncached track → 404 NOT_CACHED", pf.status === 404 && pf.json?.error?.code === "NOT_CACHED", pf.status);
	const r416 = await api("GET", `/api/v1/stream/${ONE_MORE_TIME}`, null, { headers: { Range: "bytes=999999999-" } });
	check("F20 api", "/stream Range past the end → 416 with the size", r416.status === 416 && /^bytes \*\/\d+$/.test(r416.headers.get("content-range") || ""), `${r416.status} ${r416.headers.get("content-range")}`);
	const su = await api("GET", `/api/v1/stream-url/${ONE_MORE_TIME}`);
	check("F20 api", "stream-url returns a presigned URL + expiresAt", !!su.json?.data?.url && !!su.json?.data?.expiresAt, su.text.slice(0, 160));
	const probe = await api("GET", "/api/v1/stream-progressive/3135560?probe=1");
	check("F20 api", "probe answers without opening audio", probe.status === 200 && probe.json?.data?.ok === true, probe.text.slice(0, 160));
	const gc1 = await api("GET", "/api/v1/internal/gc", null, { auth: false });
	const gc2 = await api("GET", "/api/v1/internal/gc", null, { auth: false, headers: { Authorization: `Bearer ${cronSecret}` } });
	check("F20 api", "GC cron route: 401 without the secret, runs with it", gc1.status === 401 && gc2.status === 200 && gc2.json?.data?.ran === true, `${gc1.status} ${gc2.status}`);
	const bad = await api("POST", "/api/v1/auth/login-arl", null, { headers: { "Content-Type": "application/json" } });
	check("F20 api", "login-arl with an empty body → 400 INVALID_BODY", bad.status === 400 && bad.json?.error?.code === "INVALID_BODY", `${bad.status} ${bad.text.slice(0, 160)}`);
	const tl = await api("GET", "/api/v1/content/tracklist?id=not-a-deezer-id&type=playlist");
	check("F20 api", "tracklist with a non-Deezer id → 400, not 500", tl.status === 400, tl.status);

	// F21 — sign out (the settings page stays open and switches to its guest view)
	await p.goto("/settings", 4000);
	check("F21 signout", "Sign out clicked", !!(await p.click("^Sign out$")));
	const guest = await until(async () => (await p.labels("^Sign out$")).length === 0, 10000);
	const old = await api("GET", "/api/v1/library/tracks");
	check("F21 signout", "guest view and the old session is revoked", !!guest && old.status === 401, `${guest} ${old.status}`);
	const playerGone = await until(async () => (await p.labels("^(Pause|Play|Next track)$")).length === 0, 5000);
	check("F21 signout", "the player is reset on sign-out", !!playerGone, JSON.stringify(await p.labels("^(Pause|Play|Next track)$")));

	// Global
	const failed = [...p.net, ...(anon?.net ?? [])].filter((r) => r.status >= 500 || (r.failed && !/canceled|ERR_ABORTED/i.test(r.failed)));
	check("G global", "no 5xx / network failure seen by the browser", failed.length === 0, JSON.stringify(failed.slice(0, 6).map((r) => [r.url.slice(0, 80), r.status, r.failed])));
	const errs = [...p.consoleErrors, ...(anon?.consoleErrors ?? [])].filter((e) => !/Failed to load resource: the server responded with a status of 40[134]/.test(e));
	check("G global", "no uncaught page errors / console errors", errs.length === 0, errs.slice(0, 6).join(" || "));
	await p.closeTab();
}
