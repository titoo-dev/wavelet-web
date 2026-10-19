# Browser end-to-end checks

`npm run e2e` drives headless Chrome through the critical web flows against a
**production build** (`next build` + `next start`). It covers:

- auth;
- home, search and ⌘K;
- album playback: first play on the live stream, a far seek on it (Range), next/previous, pause/resume;
- the queue, lyrics and fullscreen panels;
- persistence and recent plays;
- refresh resume;
- library and playlists;
- public share links, signed out;
- download;
- settings;
- the artist page;
- API contracts;
- sign-out.

A second suite checks gapless playback with the setting on.

It does not run in CI: it plays real Deezer tracks and writes to an R2 bucket.

## Requirements

- Docker (a throwaway `postgres:16-alpine` on port `15499`)
- Google Chrome (`CHROME_PATH` if it is not in the default location)
- `.env` / `.env.local` with:
  - `BETTER_AUTH_SECRET`
  - `WAVELET_SERVICE_ARL`, a Deezer account the checks sign in with
  - `R2_*` for the **dev** bucket. The runner refuses `wavelet-music` (production).

## What it does

1. Starts the throwaway database and applies the migrations.
2. Builds, then runs `next start` on port 3000.
3. Seeds a signed-in user (`e2e/lib/stack.mjs`) with a plaintext ARL, which also exercises the legacy re-encryption path.
4. Runs `e2e/critical-flows.mjs`, then `e2e/gapless.mjs`.
5. Deletes every R2 object the run persisted, then stops the server and the database.

Env: `E2E_PORT`, `E2E_PG_PORT`, `E2E_SKIP_BUILD=1` (reuse `.next`), `E2E_KEEP=1` (leave the stack up to debug).

## Writing checks

- `e2e/lib/cdp.mjs` is a small DevTools-protocol driver with no dependencies.
  - `click` sends a real mouse click; use it for user gestures.
  - `clickJs` calls `element.click()`, for controls that only show on hover.
  - `audio()` / `active()` read the media elements the page played.
  - `nowPlaying()` reads the Media Session title.
  - `seekBarTo(s)` clicks the player's seek bar.
- Wait about 4 s after a reload before clicking, so React has hydrated.
- Pause through the UI, not `element.pause()`, which desyncs the store.
- A second tab backgrounds the first. Close it and call `front()` on the main page.
- Headless Chrome stalls blob downloads to disk, so check the blob the app creates (`window.__blobs` / `window.__saves`).

## Multi-device suite

`npm run e2e:devices` (`e2e/multi-device.mjs`) opens two signed-in tabs on one Playback Session: a Remote that stays silent and controls the Active Device (pause, play, next), a Transfer that carries on from the same position, a paused session that stays paused through a Transfer, and the Active Device going away (paused, no Active Device, Play elsewhere takes over).

- Needs Docker, Chrome and the Convex deployment of `.env.local`: `CONVEX_AGENT_MODE=anonymous npx convex dev` running, with `npx convex env set BETTER_AUTH_URL http://localhost:3000` (Convex fetches the JWT keys from the app).
- No Deezer or R2: the browser answers the stream routes with a silent MP3 that serves byte ranges, every track "stored". The tabs bypass the Service Worker, which would otherwise fetch the streams out of reach of that stub.
- A new user per run: the Convex deployment keeps the previous run's session.
- The device picker's item is picked with `element.click()`: a synthetic mouse click can land while the popup still animates in.
