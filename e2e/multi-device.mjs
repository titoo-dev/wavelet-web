// npm run e2e:devices — two signed-in tabs on one Playback Session (CONTEXT.md, docs/adr/0001-0003),
// against a production build, a throwaway Postgres and the Convex deployment of .env.local
// (`CONVEX_AGENT_MODE=anonymous npx convex dev`, with BETTER_AUTH_URL=http://localhost:3000 set on
// it). No Deezer or R2: the stream routes are answered in the browser with a silent MP3.
// Env: E2E_PORT (3000), E2E_PG_PORT (15499), E2E_SKIP_BUILD=1, E2E_KEEP=1, CHROME_PATH.
import { createHmac, randomBytes } from "crypto";
import { config } from "dotenv";
import { launch, openPage, sleep, until } from "./lib/cdp.mjs";
import { ROOT, Server, ThrowawayDb, checker } from "./lib/stack.mjs";

config({ path: `${ROOT}/.env.local`, quiet: true });
config({ path: `${ROOT}/.env`, quiet: true });
if (!process.env.NEXT_PUBLIC_CONVEX_URL) throw new Error("NEXT_PUBLIC_CONVEX_URL missing: run `npx convex dev` first");
process.env.BETTER_AUTH_SECRET ||= randomBytes(32).toString("hex");
process.env.GOOGLE_CLIENT_ID ||= "e2e";
process.env.GOOGLE_CLIENT_SECRET ||= "e2e";

const { check, results } = checker();
const db = new ThrowawayDb({ port: Number(process.env.E2E_PG_PORT || 15499) });
const server = new Server({ port: Number(process.env.E2E_PORT || 3000), db, cronSecret: "e2e" });
let browser = null;
let streamsStubbed = false;

/** 60 s of silent MPEG-1 Layer III (128 kb/s, 44.1 kHz, mono): 2297 frames of 417 bytes. */
function silentMp3(seconds = 60) {
	const frames = Math.ceil((seconds * 44100) / 1152);
	const frame = Buffer.alloc(417);
	frame.set([0xff, 0xfb, 0x90, 0xc4]);
	return Buffer.concat(Array.from({ length: frames }, () => frame));
}
const MP3 = silentMp3();

/** The stream routes' answer: the whole file, or the asked-for range as a 206 like the live stream route. */
function mp3Reply(headers) {
	const range = /bytes=(d+)-(d*)/.exec(headers.Range || headers.range || "");
	const start = range ? Number(range[1]) : 0;
	const end = range && range[2] ? Math.min(Number(range[2]), MP3.length - 1) : MP3.length - 1;
	const body = MP3.subarray(start, end + 1);
	return {
		responseCode: range ? 206 : 200,
		responseHeaders: [
			{ name: "Content-Type", value: "audio/mpeg" },
			{ name: "Accept-Ranges", value: "bytes" },
			{ name: "Content-Length", value: String(body.length) },
			...(range ? [{ name: "Content-Range", value: `bytes ${start}-${end}/${MP3.length}` }] : []),
		],
		body: body.toString("base64"),
	};
}

const track = (n) => ({ trackId: String(9000 + n), title: `Silence ${n}`, artist: "E2E", cover: null, duration: 60 });
const QUEUE = [track(1), track(2), track(3)];

async function seedUser() {
	// A new user per run: the Convex deployment keeps the previous run's session.
	const userId = `e2e-devices-${randomBytes(4).toString("hex")}`;
	const token = randomBytes(24).toString("hex");
	await db.query(
		`INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES($1,'E2E',$1 || '@example.com',true,now(),now()) ON CONFLICT (id) DO NOTHING`,
		[userId],
	);
	await db.query(`INSERT INTO session(id,"expiresAt",token,"createdAt","updatedAt","userId") VALUES($1, now() + interval '1 day', $2, now(), now(), $3)`, [
		"e2e-" + token.slice(0, 8),
		token,
		userId,
	]);
	const sig = createHmac("sha256", process.env.BETTER_AUTH_SECRET).update(token).digest("base64");
	return "better-auth.session_token=" + encodeURIComponent(`${token}.${sig}`);
}

/** A tab whose stream requests get the silent MP3, and whose player starts with `queue` if given. */
async function tab(cookie, queue) {
	const page = await openPage(browser, { base: server.base, cookie });
	// The app's Service Worker would fetch the streams itself, out of reach of the stub below.
	await page.S("Network.setBypassServiceWorker", { bypass: true });
	await page.S("Fetch.enable", {
		patterns: [
			{ urlPattern: "*/api/v1/stream-url/*" },
			{ urlPattern: "*/api/v1/stream-progressive/*" },
			{ urlPattern: "*/api/v1/stream/*" },
			{ urlPattern: "*/e2e-stored/*" },
		],
	});
	if (!streamsStubbed) {
		streamsStubbed = true;
		browser.listeners.push((m) => {
			if (m.method !== "Fetch.requestPaused" || m.sessionId === undefined) return;
			const { requestId, request } = m.params;
			const json = (body) => ({
				responseCode: 200,
				responseHeaders: [{ name: "Content-Type", value: "application/json" }],
				body: Buffer.from(JSON.stringify(body)).toString("base64"),
			});
			// Every track is "stored": a presigned-like URL that serves byte ranges, so a Device taking
			// over mid-track starts where the session is (the live stream would wait for a stored copy).
			const id = /stream-url\/([^/?]+)/.exec(request.url)?.[1];
			const reply = id
				? json({
						success: true,
						data: {
							url: `${server.base}/e2e-stored/${id}.mp3`,
							contentType: "audio/mpeg",
							expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
						},
					})
				: mp3Reply(request.headers);
			void browser.send("Fetch.fulfillRequest", { requestId, ...reply }, m.sessionId).catch(() => {});
		});
	}
	if (queue) {
		const state = { state: { queue, queueIndex: 0, currentTrack: queue[0], volume: 80, _lastNonZeroVolume: 80, shuffle: false, repeat: "off" }, version: 0 };
		await page.S("Page.addScriptToEvaluateOnNewDocument", {
			source: `try{if(!sessionStorage.getItem("e2e-seeded")){localStorage.setItem("wavelet-player",${JSON.stringify(JSON.stringify(state))});sessionStorage.setItem("e2e-seeded","1")}}catch(e){}`,
		});
	}
	return page;
}

/**
 * Device picker → "This device", then waits for the tab to stop calling itself a Remote; returns
 * how many tries it took (0: never).
 */
async function pick(page) {
	for (let attempt = 1; attempt <= 2; attempt++) {
		await page.click("Choose a device");
		await sleep(600);
		// element.click(): a synthetic mouse click can land while the popup still animates in.
		await page.clickJs("This device", { selector: "[role=menuitemradio]" });
		if (await until(() => syncRole(page).then((r) => r !== "remote"), 8000)) return attempt;
	}
	return 0;
}

const playing = async (page) => (await page.active())?.src ?? null;
function syncRole(page) {
	return page.ev(`document.querySelector('[aria-label^="Playing on"]') ? "remote" : "other"`);
}

try {
	console.log("▶ throwaway Postgres + migrations");
	await db.start();
	if (process.env.E2E_SKIP_BUILD !== "1") {
		console.log("▶ next build");
		server.build();
	}
	console.log(`▶ next start on ${server.base}`);
	await server.start();
	browser = await launch({ port: 9362 });
	const cookie = await seedUser();

	console.log("▶ tab A plays");
	const a = await tab(cookie, QUEUE);
	await a.goto("/");
	await a.front();
	check("A", "player restored from the seeded queue", await until(() => a.click("^Play$", { tries: 1 })));
	check(
		"A",
		"plays on Play (claims the session)",
		await until(() => playing(a).then((s) => s && /9001/.test(s))),
		JSON.stringify({ audio: await a.audio(), streams: a.net.filter((r) => /stream|token/.test(r.url)), errors: a.consoleErrors.slice(0, 5) }),
	);
	const jwt = a.net.find((r) => r.url === "/api/auth/token");
	check("A", "traded its session for a Convex JWT", jwt?.status === 200, JSON.stringify(jwt));

	console.log("▶ tab B opens: a Remote");
	const b = await tab(cookie);
	await b.goto("/");
	await b.front();
	check("B", "shows the session's track", await until(() => b.ev(`document.body.innerText.includes("Silence 1")`)));
	check("B", "says where it plays", await until(() => syncRole(b).then((r) => r === "remote")));
	check("B", "outputs no sound (was: every tab played)", !(await playing(b)), JSON.stringify(await b.audio()));
	check("B", "opening it did not take playback over", !!(await playing(a)));

	console.log("▶ B pauses, resumes, skips");
	await b.click("^Pause$");
	check("B → A", "Pause on the Remote pauses the Active Device", await until(async () => !(await playing(a)), 10000), JSON.stringify(await a.audio()));
	await b.click("^Play$");
	check("B → A", "Play on the Remote resumes there", await until(() => playing(a), 10000), JSON.stringify(await a.audio()));
	await b.click("^Next track$");
	check(
		"B → A",
		"Next on the Remote plays the next track there",
		await until(() => playing(a).then((s) => s && /9002/.test(s)), 10000),
		JSON.stringify(await a.audio()),
	);
	check("B", "follows the Active Device's track", await until(() => b.ev(`document.body.innerText.includes("Silence 2")`)));
	check("B", "still silent", !(await playing(b)));

	console.log("▶ Transfer to B");
	await sleep(3000);
	const posA = (await a.active())?.t ?? 0;
	const pickedAt = Date.now();
	const tries = await pick(b);
	check("Transfer", "the picker hands the sound over", tries === 1, tries ? `took ${tries} clicks` : "never");
	// B may play its IndexedDB copy (blob: URL): the title says which track it is.
	check(
		"Transfer",
		"B plays the same track",
		(await until(() => playing(b), 15000)) && (await b.ev(`document.body.innerText.includes("Silence 2")`)),
		JSON.stringify(await b.audio())
	);
	// A kept playing until the Transfer, B carries on from there: B ≈ A + the time it took.
	const posB = (await b.active())?.t ?? 0;
	const expected = posA + (Date.now() - pickedAt) / 1000;
	check("Transfer", "from about the same position", posB > 0 && Math.abs(posB - expected) < 3, `A ${posA}s → B ${posB}s (expected ~${expected.toFixed(1)}s)`);
	check("Transfer", "A fell silent", await until(async () => !(await playing(a)), 10000), JSON.stringify(await a.audio()));
	await a.front();
	check("A", "now says it plays on the other tab", await until(() => syncRole(a).then((r) => r === "remote")));

	console.log("▶ B pauses, Transfer back to A keeps it paused");
	await b.front();
	await b.click("^Pause$");
	await until(async () => !(await playing(b)), 10000);
	await a.front();
	await pick(a);
	await sleep(4000);
	check("Transfer", "a paused session stays paused", !(await playing(a)) && !(await playing(b)));

	console.log("▶ the Active Device goes away");
	await a.click("^Play$");
	check("A", "plays again", await until(() => playing(a), 10000), JSON.stringify({ audio: await a.audio(), role: await syncRole(a), labels: await a.labels("^(Play|Pause)$") }));
	await a.closeTab();
	await b.front();
	check("B", "the session is left paused with no Active Device", await until(() => syncRole(b).then((r) => r !== "remote"), 20000));
	await b.click("^Play$");
	check("B", "Play there makes it the Active Device", await until(() => playing(b), 10000), JSON.stringify(await b.audio()));

	const errors = server.serverErrors();
	check("server", "no unhandled server error in the log", errors.length === 0, errors.join(" | "));
	const pageErrors = b.consoleErrors.filter((e) => /convex|playback|sync/i.test(e));
	check("B", "no sync errors in the console", pageErrors.length === 0, pageErrors.join(" | "));
} catch (e) {
	check("runner", "stack / runner", false, e.stack);
} finally {
	if (process.env.E2E_KEEP !== "1") {
		await browser?.close();
		server.stop();
		db.stop();
	}
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
