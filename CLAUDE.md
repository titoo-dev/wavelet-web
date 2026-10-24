# Project: wavelet

Music download/streaming app built with Next.js 16, React 19, Prisma 7, Zustand, Tailwind 4. Hosted on Vercel — everything runs inside Next.js, no external Node service (setup: `docs/vercel.md`).

## Next.js 16 — Breaking Changes

This project uses Next.js 16 which has breaking changes from earlier versions. **Do not rely on training data for Next.js APIs.** Use Context7 MCP (`resolve-library-id` → `query-docs`) to look up any Next.js API before writing code.

## Stack

- **Frontend**: Next.js 16 (app router), React 19, Zustand stores, Tailwind CSS 4, shadcn/ui, Motion
- **Backend**: Next.js API routes (`src/app/api/v1/`) on Vercel Functions (Fluid compute). Background work after a response goes through `after()` — a bare fire-and-forget promise is frozen when the response ends.
- **Database**: PostgreSQL (Neon via Vercel Marketplace) through Prisma 7 + `pg` pool attached with `attachDatabasePool` (schema at `prisma/schema.prisma`; migrations in `prisma/migrations/` are applied by `prisma migrate deploy` during the Vercel build — create new ones with `npm run db:migrate`)
- **Storage**: private Cloudflare R2 buckets (`wavelet-music` prod/preview, `wavelet-music-dev` dev; `R2_*` env vars) — writes via `R2StorageProvider` (`src/lib/wavelet/storage/`, signed with `aws4fetch` in `r2.ts`), reads/presigned URLs via `src/lib/object-stream.ts`. Moved off Vercel Blob after its Hobby quota suspended the stores (setup: `docs/vercel.md`). `/tmp` is the only writable path. New copies are keyed `tracks/{trackId}/{bitrate}{ext}` (legacy rows keep their `music/…` path; run `npx tsx scripts/repair-stored-track-keys.ts --apply` once to drop legacy rows that share an object). Which cached copy a play gets is decided in one place: `storage/cached-copy.ts`. A daily Vercel Cron hits `GET /api/v1/internal/gc` (needs `CRON_SECRET`, no-op without it).
- **Streaming engine** (`src/lib/wavelet/`): `decryption.ts` opens the Deezer CDN with ranges, timeouts and truncation checks (`stripe.ts` = pure BF_CBC_STRIPE maths); `progressive-stream.ts` spools persisting plays to `/tmp` first (the HTTP response tails the spool) and uploads after; same-instance followers share the spool, other instances see the `PersistLease` row and stream live. Live checks: `npx tsx scripts/smoke-deezer.ts 3135556 1` (needs `WAVELET_SERVICE_ARL`) and `scripts/e2e-progressive-persist.ts` (throwaway DB + dev bucket).
- **Secrets**: Deezer ARLs are stored encrypted (`src/lib/secret-box.ts`, key `WAVELET_ENCRYPTION_KEY` else derived from `BETTER_AUTH_SECRET` — keep it identical across environments sharing the DB). Every Deezer HTTP call goes through `src/lib/deezer/http.ts` (timeouts, bounded retries, redacted logs).
- **Auth**: better-auth (`src/lib/auth.ts`, `src/lib/auth-client.ts`); its `jwt` plugin mints the short-lived JWTs Convex trusts (`GET /api/auth/token`, keys at `/api/auth/jwks`, docs/adr/0002)
- **Lyrics Stories** (CONTEXT.md, docs/lyrics-stories.md, docs/adr/0004-0006): story videos of a Lyrics Range drawn server-side with `@napi-rs/canvas` (`src/lib/story/`: pure range / timeline / layout + 4 Story Themes in `themes/`, fonts in `assets/fonts/story/`). Done: Theme Stills (`POST /api/v1/stories/stills`); next: the Story Render (ffmpeg, R2, job row). Look at the themes with `npx tsx scripts/story-stills.ts <outDir> [coverUrl]`.
- **Multi-device playback** (CONTEXT.md, docs/adr/0001-0003): Convex (`convex/`) holds the Playback Session, the Devices and the Commands only — Postgres stays the source of truth for everything else. The web client is `src/lib/playback-sync/` (mounted by `components/audio/PlaybackSyncMount.tsx` in `(main)/layout.tsx`, off without `NEXT_PUBLIC_CONVEX_URL`); local dev: `CONVEX_AGENT_MODE=anonymous npx convex dev` then `npx convex env set BETTER_AUTH_URL http://localhost:3000`

## Design language — Geist minimal + the mobile app's expressive layer

The base stays Vercel / Geist: monochrome surfaces, hairline borders, the sticky glass header with its nav, Geist semibold with tight tracking, one blue accent (`--highlight`) for focus and now-playing. On top of it sit the "stunning" moments of the Flutter client (`~/dev/wavelet`): when you build or touch UI, add them rather than replacing the base.

- **Expressive layer** (`src/components/expressive`, reuse first): `HeroBanner` (aurora + drifting `ArtworkWall`, white copy, `HeroTitle` with the sky → indigo → pink `.brand-text` line), `CoverTheme` (re-themes a subtree's accents from artwork via `.cover-theme`; maths in `lib/cover-palette.ts`), `CollectionScaffold` (album / playlist / artist hero), `PageHero` + `TonalPill` (edge-bleed list-page hero with veiled `ArtworkWall` and tonal stat pills — Library, Playlists), `ArtCarousel` / `CardCarousel`, `BigPlayButton` (glowing), `QuickTile`, `FilterPills`, `SlidingSegments`, `SectionTitle`, `Medallion` (empty states), motion tokens (`DUR`, `EASE`, `entrance(i)`, `swap`).
- **M3 Expressive tokens**: shape scale `rounded-m3-{xs,sm,md,lg,lg-plus,xl,xl-plus,xxl}` (4 → 48px, `globals.css`), motion-physics springs `M3_SPRING.{fast,default,slow}{Spatial,Effects}` (`expressive/motion.ts` — spatial may overshoot, effects never), wavy progress `motion/WavyProgress`.
- **Tokens** (`src/app/globals.css`): the shadcn tokens are the Geist palette; the extra roles (`surface-{low,container,high,highest}`, `primary-container`, `tertiary-container`, `.bg-tonal-gradient`) are neutral greys and faint brand tints that `.cover-theme` swaps for artwork colours. `.type-display` / `.type-eyebrow` for hero titles and eyebrows. Don't name custom utilities `text-*` — `cn()` (tailwind-merge) drops them.
- Heroes bleed to the viewport edges with `mx-[calc(50%-50vw)] px-[calc(50vw-50%)]` (`html` has `overflow-x: clip`); sticky sub-bars sit at `top-[var(--header-h)]` (the whole header, nav row included on phones).

## Project Map

```
src/
├── app/
│   ├── (auth)/              # Login flow
│   ├── (main)/              # Main app pages (home, search, playlists, albums, settings)
│   ├── api/auth/[...all]/   # better-auth handler
│   ├── api/v1/              # API — library, search, shares, streaming, internal/gc (cron)
│   │   └── _lib/helpers.ts  # Shared helpers (ok, fail, handleError, requireDeezerAndApp, requireAdmin)
│   └── share/t/[shareId]/   # Public share player + OG image
├── components/
│   ├── audio/               # Player (floating pill, bottom-center), MiniPlayer (preview pill), FullscreenPlayer, SeekBar
│   │   └── engine/          # Pure, tested pieces of AudioEngine.tsx (source policy, timers, prefetch, handoff, loudness, media session)
│   ├── layout/              # AppHeader (glass top bar: nav + ⌘K trigger)
│   ├── expressive/          # Design kit mirroring the Flutter app (heroes, pills, carousels, CoverTheme, CollectionScaffold)
│   ├── command/             # CommandPalette — ⌘K search + downloads (single entry point)
│   ├── cards/               # MediaCard grid cards (hover play / download)
│   ├── motion/              # Motion-driven SVG primitives (PlayPauseIcon, ProgressRing, …)
│   ├── playlists/           # AddToPlaylist
│   ├── tracks/              # ShareButton, ShareDialog, TrackActionSheet
│   └── ui/                  # shadcn primitives (IGNORED — generated, rarely modified)
├── hooks/                   # usePrefetch, useLibrary, useUserPreferences, useKeyboardShortcuts, …
├── lib/
│   ├── wavelet/              # Streaming engine (decryption + stripe maths, progressive-stream, tagger, settings)
│   │   ├── cache/           # Per-user gw track cache, album metadata cache, per-IP rate limit
│   │   ├── config-store/    # Global settings on the Prisma `Config` table
│   │   ├── storage/         # R2 provider + client (r2.ts), cached-copy selection, persist lease, GC, key repair
│   │   ├── types/           # Track, Album, Artist, Playlist, Settings
│   │   └── utils/           # Crypto, bitrate selection, image download
│   ├── deezer/              # Deezer API client (http policy, api, gw, public-user, schemas)
│   ├── deezer-session.ts    # Single-flight Deezer login per user (stored ARL + child account)
│   ├── secret-box.ts        # AES-256-GCM for secrets at rest (ARL)
│   ├── auth.ts              # Server-side auth config
│   ├── auth-client.ts       # Client-side auth
│   ├── prisma.ts            # Prisma client singleton
│   ├── object-stream.ts     # R2 head / proxied stream / presigned URLs
│   └── server-state.ts      # Shared server state
├── stores/                  # Zustand: useAppStore, usePlayerStore, useQueueStore, etc.
└── utils/                   # api helpers, volume adjustment, misc helpers
scripts/                     # DB check, icon generation (`npm run icons`), streaming tasks
prisma/schema.prisma         # Database schema
```

## Commands

```bash
npm run dev          # Next.js dev server
npm run build        # Production build
npm run lint         # ESLint
npm run studio       # Prisma Studio
npm test             # Vitest one-shot
npm run test:watch   # Vitest watch mode
npm run test:coverage # Coverage with thresholds (gate used by CI)
npm run openapi      # Regenerate openapi.json (scripts/generate-openapi.mjs) — update it when a v1 route changes
npm run openapi:dart # Regenerate the Dart client in clients/dart (Docker + Dart SDK)
npm run e2e          # Browser checks of the critical flows + gapless on a production build (Docker, Chrome, Deezer, dev R2 — see e2e/README.md)
npm run e2e:devices  # Two tabs on one Playback Session (Docker, Chrome, the Convex dev deployment; no Deezer or R2)
```

Run `npm run e2e` before merging changes to playback, streaming routes, auth or storage: it is not part of CI (it plays real Deezer tracks and writes to the dev R2 bucket, then cleans up). Run `npm run e2e:devices` too for changes to the player store, `AudioEngine.tsx`, `src/lib/playback-sync/` or `convex/`.

If `tsc --noEmit` reports errors in `pathtemplates.ts` / `Track.ts`, delete `tsconfig.tsbuildinfo` first: a stale incremental file produces them, not the code.

## Testing & Regression Prevention

This project uses **Vitest 4** + **vitest-mock-extended** for tests. Config at `vitest.config.ts`. Reusable helpers in `src/test/helpers/` (`nextRequest.ts`, `mockPrisma.ts`, `mockAuth.ts`). Reference test to mirror: `src/app/api/v1/stream-url/[trackId]/route.test.ts`.

CI runs on every PR (`.github/workflows/ci.yml`): tests + coverage gate + `tsc --noEmit` + ESLint. Coverage thresholds: lines 90, branches 85, functions 90, statements 90 (global, scoped to the modules locked in — see `vitest.config.ts` `include`).

### Locked-in surface (do not regress without a passing replacement test)

| Domain | Source | Test |
|---|---|---|
| Player store | `src/stores/usePlayerStore.ts` | `usePlayerStore.test.ts` (71 tests) |
| Preview store | `src/stores/usePreviewStore.ts` | `usePreviewStore.test.ts` (14 tests) |
| Track-action sheet | `src/stores/useTrackActionStore.ts` | `useTrackActionStore.test.ts` (5 tests) |
| Library logic | `src/lib/library.ts` | `library.test.ts` (26 tests) |
| API auth guards (+ admin guard, generic 500 message) | `src/app/api/v1/_lib/helpers.ts` | `helpers.test.ts` (54 tests) |
| Streaming routes | `src/app/api/v1/stream{,-progressive,-url}/[trackId]/route.ts` | `route.test.ts` (32 tests) |
| Library routes | `src/app/api/v1/library/*` | `route.test.ts` (50 tests) |
| Recent plays | `src/app/api/v1/recent-plays/**` | `route.test.ts` (26 tests) |
| Autoplay (when the last track of the queue plays, repeat off, setting on, not on a Remote: one POST per last track; seeds = the last 5 tracks, current first; appended with `source: "autoplay"` only while that track is still last; server mixes the Deezer artist radios of ≤ 3 seed artists, leaves out queued / early-skipped (more early skips than listens) / played in the last 3 h / artists skipped early 3× never heard, ≤ 2 per artist, no artist twice in a row when avoidable) | `src/app/api/v1/autoplay/route.ts`, `src/lib/autoplay.ts`, `src/hooks/useAutoplay.ts` (mounted in `(main)/layout.tsx`), `usePlayerStore` `appendAutoplay` / `autoplay` | `autoplay/route.test.ts`, `autoplay.test.ts`, `useAutoplay.test.ts`, `usePlayerStore.test.ts` "autoplay" |
| Similar tracks from outside Deezer (ListenBrainz: Deezer ISRC → MusicBrainz recording, ≤ 1 req/s per instance → labs similar-recordings, no key; Last.fm `track.getSimilar` with `LASTFM_API_KEY`, skipped without; each artist + title found back with a plain Deezer search — the `artist:"…"` advanced search answers nothing — keeping the result by that artist (a credit may name more; a longer Deezer name is someone else) with that title; ≤ 10 per source; all cached a day in memory; a failing source is left out) — blended after the first radio in autoplay (seed: the playing track) and the Daily Mix (seeds: 2 loved tracks of the day's artists) | `src/lib/similar.ts` (+ live: `npx tsx scripts/smoke-similar.ts [trackId…]`) | `similar.test.ts`, `autoplay/route.test.ts`, `mixes/daily/route.test.ts` |
| Daily Mix (home; 3 of the top artists — listens 2 to the end / 1 heard / −1 early skip, follow 5 — a window moving daily through the top 9; ⅓ loved tracks by them (liked / recent, shuffled for the day), ⅔ discoveries from their radios, nothing the user has, early skips out, ≤ 3 per artist; no history → the user's own Deezer Flow, never the service account's; cached per user and day (`DailyMix`), `refresh=1` rebuilds, yesterday's served when today's fails; the client sends its local day; played with `source: "daily-mix"`) | `src/app/api/v1/mixes/daily/route.ts`, `src/lib/daily-mix.ts`, `src/hooks/useDailyMix.ts`, `(main)/_components/DailyMixCard.tsx` (home, under the quick tiles) | `mixes/daily/route.test.ts`, `daily-mix.test.ts`, `DailyMixCard.test.tsx` |
| Listening log (one `ListenEvent` per play, sent when it ends: skipped / completed / stopped / failed / transferred / closed; only once the sound started; a repeat or a closed tab reports a part, never the same part twice; keepalive fetch; server drops events > 5 min ahead, > 30 days old or ending before they start; user from the session only) | `src/app/api/v1/listens/route.ts`, `src/lib/listens.ts`, `engine/session.ts` `takeListen` / `endReasonOf` (+ wiring in `AudioEngine.tsx`) | `listens/route.test.ts`, `session.test.ts` "listening log", `AudioEngine.test.tsx` "listening log" |
| Preferences | `src/app/api/v1/preferences/route.ts` | `route.test.ts` (11 tests) |
| Download queue | `src/stores/useDownloadStore.ts`, `src/lib/download.ts` | `useDownloadStore.test.ts`, `download.test.ts` |
| ⌘K palette | `src/components/command/CommandPalette.tsx`, `src/stores/useCommandStore.ts` | `CommandPalette.test.tsx`, `useCommandStore.test.ts` |
| Theme | `src/lib/theme.ts` | `theme.test.ts` |
| Keyboard shortcuts (Space / arrows left to the browser with nothing loaded; volume on Shift+↑/↓; keys go to whoever owns them: a handler that called preventDefault, fields / widgets, Space on buttons and links, dialogs and menus except player surfaces marked `data-hotkeys="player"`; held keys only repeat seek / volume; physical letter on non-Latin layouts; Escape closes the top-most player layer only; page inert under Now Playing / immersive lyrics; quality radiogroup arrows; share player Space / J / L) | `src/hooks/useKeyboardShortcuts.ts`, `src/lib/hotkeys.ts`, `src/components/layout/BehindOverlays.tsx`, `FullscreenPlayer.tsx` (focus), `TrackActionMenu.tsx` (new-playlist Escape), `CommandPalette.tsx` (IME), `share/t/[shareId]/SharePlayer.tsx` | `useKeyboardShortcuts.test.ts`, `hotkeys.test.ts`, `BehindOverlays.test.tsx`, `FullscreenPlayer.test.tsx`, `TrackActionMenu.test.tsx`, `CommandPalette.test.tsx`, `SharePlayer.test.tsx` |
| Player seek bar | `src/components/audio/SeekBar.tsx` | `SeekBar.test.tsx` (+ `Player.test.tsx`) |
| Seeking on the live stream | `src/lib/seek.ts` (used by `AudioEngine.tsx` seek / resume paths) | `seek.test.ts` |
| DB connection string | `src/lib/db-url.ts` (used by `prisma.ts`) | `db-url.test.ts` |
| Fullscreen wave seek | `src/components/audio/WaveSeek.tsx`, `src/lib/wave.ts`, `src/lib/spectrum.ts` | `WaveSeek.test.tsx`, `wave.test.ts`, `spectrum.test.ts` (+ `FullscreenPlayer.test.tsx`) |
| Stream failure diagnosis | `src/lib/stream-failure.ts` (used by `AudioEngine.tsx` give-up path) | `stream-failure.test.ts` |
| Logo / icons | `src/lib/logo.ts` (shared by `LogoMark`, OG image, `scripts/generate-icons.ts`) | `logo.test.ts` |
| Object storage (R2) | `src/lib/object-stream.ts`, `src/lib/wavelet/storage/{objects,r2,R2StorageProvider}.ts` | `object-stream.test.ts`, `objects.test.ts`, `R2StorageProvider.test.ts` |
| Progressive persist pipeline (disk-first spool: the writer never waits for a listener, tail readers follow their client; preview / live keep backpressure; truncation never persists; untagged upload when enrichment fails; `tracks/{trackId}/{bitrate}` keys) + download-lock TTL / follower hand-off + `PersistLease` | `src/lib/wavelet/{tee-pump,progressive-stream}.ts`, `src/lib/wavelet-app.ts`, `src/lib/wavelet/storage/persist-lease.ts` | `tee-pump.test.ts`, `progressive-stream.test.ts`, `wavelet-app.test.ts`, `persist-lease.test.ts` (+ live: `scripts/e2e-progressive-persist.ts`) |
| Deezer stream decryption (BF_CBC_STRIPE, decoded byte ranges + probe cache, truncation → `TruncatedStreamError`, CDN connect/response/idle timeouts, one retry before the first byte) | `src/lib/wavelet/{decryption,stripe,stream-errors}.ts`, `src/lib/wavelet/utils/crypto.ts` | `decryption.test.ts`, `stripe.test.ts`, `utils/crypto.test.ts` (+ live: `npx tsx scripts/smoke-deezer.ts 3135556 1`) |
| Streaming routes v2 (Range 206/416 on the live stream, `?probe=1`, `?prefetch=1` → 404 NOT_CACHED, `expiresAt`, head prefetch sized in seconds) | `src/app/api/v1/stream{,-progressive,-url,-warm}/**`, `stream-progressive/_lib/{play,head}.ts` | `route.test.ts` ×4, `play.test.ts`, `head.test.ts` |
| Cached-copy selection (quality rank, licence cap, `requestedBitrate`) | `src/lib/wavelet/storage/cached-copy.ts` | `cached-copy.test.ts` |
| Storage GC + eviction guards (grace period, lease, shared-object guard) | `src/lib/wavelet/storage/{gc,key-repair}.ts`, `src/app/api/v1/internal/gc/route.ts`, `library.ts` `maybeEvictFile` / `forceEvictFile` | `gc.test.ts`, `key-repair.test.ts`, `internal/gc/route.test.ts`, `library.test.ts` |
| Public share stream (cached copy by trackId, lease/follower fallback, per-IP limit, honest play count) | `src/app/api/v1/shares/[shareId]/stream/route.ts`, `src/lib/wavelet/cache/rate-limit.ts` | `route.test.ts`, `rate-limit.test.ts` |
| Share links (metadata from Deezer else sanitized client values, Deezer-only covers, one live link per user + track, expired links never reused / never anchor files / purged after 30 days, `INVALID_EXPIRY`, public GET without avatar, `private, no-cache` stream, store drops expired links and resets on sign-out, OG font bundled, public player errors / no preload) | `src/app/api/v1/shares/{route,[shareId]/route}.ts`, `src/lib/share-meta.ts`, `src/stores/useShareStore.ts`, `src/app/share/t/[shareId]/{page,SharePlayer,opengraph-image,og-font}.tsx?`, `src/components/tracks/ShareDialog.tsx` | `route.test.ts` ×2, `share-meta.test.ts`, `useShareStore.test.ts`, `SharePlayer.test.tsx`, `opengraph-image.test.tsx`, `expired.test.tsx`, `og-font.test.ts`, `ShareDialog.test.tsx` |
| Deezer client hardening (timeouts, bounded retries, typed network errors, licence refusal → `WrongLicense`, secret-free logs) | `src/lib/deezer/{http,gw,api,deezer,errors,public-user}.ts`, `src/lib/log-safe.ts` | `http.test.ts`, `gw.test.ts`, `api.test.ts`, `deezer.test.ts`, `public-user.test.ts`, `log-safe.test.ts` |
| Bitrate selection (falls back only when a format is really unavailable) | `src/lib/wavelet/utils/getPreferredBitrate.ts` | `getPreferredBitrate.test.ts` |
| Deezer sessions + encrypted ARL (single-flight login, persisted child account) | `src/lib/deezer-session.ts`, `src/lib/secret-box.ts`, `src/lib/server-state.ts` | `helpers.test.ts`, `secret-box.test.ts`, `server-state.test.ts` |
| Auth + settings routes (no `license_token` in responses; admin-only server quality via `WAVELET_ADMIN_EMAILS`; authenticated settings POST) | `src/app/api/v1/auth/{login-arl,login-email,change-account,connect}/route.ts`, `src/app/api/v1/settings/{route,quality/route}.ts` | `route.test.ts` ×6 |
| Config store on Prisma (no runtime DDL) | `src/lib/wavelet/config-store/PostgresConfigStore.ts` | `PostgresConfigStore.test.ts` |
| Player engine (source policy, presigned cache + re-sign, guarded timers, per-track session, prefetch that never persists, head handoff, loudness, media session, sign-out reset) | `src/components/audio/engine/*.ts`, `src/components/audio/AudioEngine.tsx` | `engine/*.test.ts`, `AudioEngine.test.tsx` |
| Gapless runs (setting `gapless`, off by default; cached MP3s only): LAME tag parser (`Lame3.100` too), MSE timeline (decoder delay 0 in Chrome, window closed on a frame boundary), deck pump (chunked appends under a 10 MB budget, seek re-append, quota / failure → plain path), run policy | `src/components/audio/engine/{mp3-gapless,gapless-timeline,gapless-deck,gapless-policy}.ts` (+ wiring in `AudioEngine.tsx`) | `mp3-gapless.test.ts` (real Deezer headers in `src/test/fixtures/mp3-heads.ts`), `gapless-timeline.test.ts`, `gapless-deck.test.ts` (fake MSE: `src/test/helpers/fake-mse.ts`), `gapless-policy.test.ts`, `AudioEngine.test.tsx` "gapless runs" |
| Audio cache + Service Worker (one-transaction IndexedDB, LRU plan, read-only worker, Range maths) | `src/lib/audio-cache.ts`, `public/sw.js` (vm sandbox: listed, not measured by coverage) | `audio-cache.test.ts`, `audio-cache.idb.test.ts`, `service-worker.test.ts` |
| Web Audio volume + prefetch budget | `src/utils/{audio-context,adjust-volume}.ts`, `src/lib/prefetch-budget.ts`, `src/hooks/usePrefetch.ts` | `audio-context.test.ts`, `prefetch-budget.test.ts`, `usePrefetch.test.ts` |
| Cover palette (CoverTheme seed) | `src/lib/cover-palette.ts` | `cover-palette.test.ts` |
| Home discover parsing | `src/lib/discover.ts` (used by `hooks/useDiscover.ts`) | `discover.test.ts` |
| Bearer auth (native clients) + Convex JWT (`jwt()` plugin: RS256, `iss` = BETTER_AUTH_URL, `aud` convex, 15 min, subject = user id, no JWT header on getSession) | `src/lib/auth.ts` (better-auth `bearer()` + `jwt()`), `prisma/schema.prisma` `Jwks` | `auth.test.ts` |
| Playback Session on Convex (every function needs the JWT and stays within its user; only the Active Device publishes, any Device with no Active Device; claim refused to the second Device; Transfer keeps the intent, extrapolates the position up to the track's end, refuses an unknown / offline Device (a not yet activated tab is accepted) and drops the previous Active Device's Commands; Commands wait in order for the Active Device and only it acks them; the presence sweep drops an Active Device silent for 45 s, paused at the position it had when last seen, and forgets Devices gone for a month; reclaim only when nobody took over; `updatedBy` names the writer) | `convex/{lib,devices,playback,commands,presence,crons,schema,validators}.ts` | `convex/playback.test.ts` (convex-test, `// @vitest-environment edge-runtime`) |
| Playback sync, web (roles local / idle / active / remote; a Remote's store actions become Commands — queue edits and transport show at once, play / next / jump wait for the Active Device, `stop` stays local; the session mirrored into the store with its position extrapolated; publish debounced, the queue only when it changed, as a window of 1000 around the current track; claim on Play with no Active Device, a refused claim plays on the winner; reclaim after a drop; Commands run once each then acked; "not responding" after 5 s; a duplicated tab gets its own Device id; tracks stripped to the fields Convex stores) | `src/lib/playback-sync/*.ts`, `usePlayerStore.ts` (routing), `AudioEngine.tsx` (silent while a Remote, resumes at the session's position once active, a play the autoplay policy refuses pauses and asks for a click, a Transfer is not a skip, a Preview on a Remote pauses the Active Device for good), `components/audio/DevicePicker.tsx` (+ `useShownVolume`), `utils/adjust-volume.ts` (fades follow the clock: a pause in a hidden tab lands in ≤ 1 s) | `sync.test.ts`, `track.test.ts`, `device.test.ts`, `execute.test.ts`, `usePlayerStore.test.ts` "on a Remote", `AudioEngine.test.tsx` "multi-device", `DevicePicker.test.tsx`, `audio-context.test.ts` (+ browser: `npm run e2e:devices`) |
| Lyrics Stories core + Theme Stills (a Lyrics Range from the client: 1–30 lines, times non-decreasing, text cleaned of control / bidi characters ≤ 200 chars, at least one sung line; excerpt = first line − 0.3 s → next line, or + 4 s after the song's last line, capped at the track's end, 5–30 s; the first line shown from frame 0, the next ones scroll in over 350 ms eased; layout once per render: largest size where every line fits 3 rows, else cut with "…"; cover only from Deezer's CDN at 1000 px, ≤ 5 s / 5 MB, none → the brand seed; Geist + Noto Sans, a missing font file throws; still = halfway through the first line, 720×1280 JPEG; 60 stills a minute per user, refused requests not counted) | `src/lib/story/{range,timeline,layout,color,fonts,still}.ts`, `src/lib/story/themes/*.ts`, `src/app/api/v1/stories/stills/route.ts` | `range.test.ts`, `timeline.test.ts`, `layout.test.ts`, `color.test.ts`, `fonts.test.ts`, `still.test.ts`, `stills/route.test.ts` |
| Lyrics lookup (LRCLIB get → Deezer → scored search) | `src/lib/lyrics/{match,lrc,deezer-sync,resolve,cache}.ts`, `src/app/api/v1/lyrics/[trackId]/route.ts`, `src/stores/useLyricsStore.ts` | `match.test.ts`, `lrc.test.ts`, `resolve.test.ts`, `cache.test.ts`, `route.test.ts`, `useLyricsStore.test.ts` |
| Spotify import (≤ 1000 tracks: read → match in batches of 50 → save; runs on after the dialog closes) | `src/lib/spotify/{import,import-run,link-input}.ts`, `src/stores/useSpotifyImportStore.ts`, `src/app/api/v1/playlists/import/spotify/{playlist,match,save}/route.ts`, `src/components/motion/WavyProgress.tsx`, `components/playlists/SpotifyLinksField.tsx` (one item per pasted link) (UI: `components/playlists/ImportSpotifyDialog.tsx` + `ImportStage.tsx`, mounted in `(main)/layout.tsx`) | `import.test.ts`, `import-run.test.ts`, `useSpotifyImportStore.test.ts`, `route.test.ts` ×3, `WavyProgress.test.tsx`, `ImportStage.test.tsx`, `link-input.test.ts`, `SpotifyLinksField.test.tsx` |
| Artist / album links (id, else name / title fallback) | `src/lib/entity-links.ts`, `src/components/links/EntityLink.tsx`, `src/components/audio/leave-player.ts` (resolved by `artist/page.tsx` `?name=`, `album/page.tsx` `?title=`) | `entity-links.test.ts`, `EntityLink.test.tsx`, `leave-player.test.ts` |
| Overlay history (Now Playing, immersive lyrics, phone queue and ⌘K own a history entry: Back closes the top-most one; links out replace it; route change closes them) | `src/lib/overlay-history.ts`, `src/hooks/useOverlayHistory.ts` (mounted in `(main)/layout.tsx`), `EntityLink.tsx` `useOverlayLink` | `overlay-history.test.ts`, `useOverlayHistory.test.ts`, `EntityLink.test.tsx` |
| Sign-in round trip + sign-out (`/login?next=` in-app paths only, no open redirect; Deezer logout before the app sign-out; local state cleared only once the server agreed; header leaves private pages) | `src/lib/login-redirect.ts`, `src/lib/sign-out.ts`, `hooks/useLoginHref.ts`, `components/links/SignInLink.tsx`, `(auth)/login/page.tsx`, `AppHeader.tsx` | `login-redirect.test.ts`, `sign-out.test.ts`, `login/page.test.tsx`, `AppHeader.test.tsx`, `my-playlists/[id]/page.test.tsx` |
| Collection pages load / retry / back (network failure = "error" + Try again, never "not found"; name / title resolution never opens an unrelated entity; recent pages cached for Back / Forward; library tab from `?tab=`; playlist reorder sent when leaving mid-debounce) | `src/components/collection/{useTracklist,LoadFailed}.ts(x)`, `src/lib/entity-links.ts` `pick*Id`, `src/lib/trailing-send.ts`, `artist/page.tsx`, `album/page.tsx`, `playlist/page.tsx`, `library/page.tsx`, `my-playlists/[id]/page.tsx` | `useTracklist.test.ts`, `entity-links.test.ts`, `trailing-send.test.ts`, `artist/page.test.tsx`, `library/page.test.tsx` |
| App chrome: Back / Forward in the installed app (Navigation API; parent page when nothing is behind), top loader on navigations (link clicks, ⌘K, search; shows after 120 ms; ends on URL change or after 15 s), header clear of the status bar (`--header-h` includes the inset), per-page skeletons | `src/components/layout/{HistoryNav,NavProgress}.tsx`, `src/lib/nav-progress.ts`, `AppHeader.tsx`, `globals.css` `--header-h`, `(main)/{library,settings,about,errors}/loading.tsx` | `HistoryNav.test.tsx`, `NavProgress.test.tsx`, `AppHeader.test.tsx`, `header-height.test.ts`, `page-loading.test.tsx` |
| Home data straight from the database (no loopback HTTP to our own API; one session read; a failing source renders empty) + ⌘K "See all results" over a /search draft | `src/app/(main)/page.tsx`, `src/lib/playlist-summaries.ts` (shared with `GET /api/v1/playlists`), `useCommandStore` `submitSearch`, `SearchScreen.tsx` | `(main)/page.test.tsx`, `SearchScreen.test.tsx` |

### Fix-bug-once strategy (read this before fixing anything)

**Every bug fix must ship with a failing-then-passing test.** No exceptions. The workflow is:

1. **Reproduce the bug as a test first.** Before touching the source, write a test that captures the exact failure (status code, error message, redirect target, store state, whatever the symptom is). The test must fail.
2. **Fix the source.**
3. **Re-run the test — it must now pass.** Then run the whole suite to make sure nothing else broke.
4. **Name the test after the bug.** e.g. `it("does not redirect to /stream when S3 is unreachable (was: 500 ENOTFOUND in Network tab)")`. The "was:" tag makes the test self-documenting and grep-able when the same symptom returns.

This is non-negotiable for the locked-in modules above — CI enforces it via the coverage gate (a regression in those modules would have to delete an existing test, which is visible in the diff).

For new code outside the locked-in surface, write at minimum one test per branch you add. If you add a new error code path, write a test for it in the same PR. Untested new code is a future bug waiting to be re-fixed.

### When you find a non-blocking quirk

If you spot behavior that looks wrong but is intentional (or you don't have time to fix it), **lock it in with a test** that asserts the current behavior, plus a `// TODO:` comment explaining what the right behavior would be. This way:
- The current behavior can't silently change.
- The test fails the moment someone "fixes" it without updating the test — forcing them to consciously decide what the new contract should be.

Examples already in the suite (search for `TODO` in `*.test.ts`):
- `library/tracks` GET treats `limit=0` as default 100 instead of clamping to 1.
- `recent-plays` GET treats `limit=0` as default 50.
- `library/status` POST silently coerces non-array `trackIds`/`albumIds` to `[]` instead of 400.

### Out of scope (still to be locked)

- `AudioEngine.tsx` React wiring end-to-end in a real browser (the pure helpers live in `components/audio/engine/` and are tested; `AudioEngine.test.tsx` drives a fake `<audio>`). Plan: Playwright for the full flow, incl. iOS Safari background playback.
- Routes: `playlists/**`, `search/**`, `content/**`, `auth/logout`.
- Deezer client remainder: `gw.ts` / `api.ts` / `utils.ts` page parsers (retry/timeout policy is locked; the mappers are not), `wavelet-app.ts` settings code.
- Stores: `useAuthStore`, `useAppStore`, `useLoginStore`, `useErrorStore`.

When you finish locking in any of the above, append it to the table above and to `vitest.config.ts` `coverage.include`.

## Database Models (Prisma)

```
User            ── 1:many ── Session, Account, Playlist, SavedTrack, Album, FollowedArtist, SharedTrack, RecentPlay, ListenEvent
                ── 1:1 ──── DailyMix (cache)
                ── 1:1 ──── UserSettings (JSON blob), UserPreferences (JSON blob), DeezerCredential
DeezerCredential── encrypted ARL (enc:v1), licence flags (canStreamHq / canStreamLossless), childAccount
Config          ── key/value store (userId + key composite PK, JSON value) — global settings (server-wide maxBitrate, …)
Playlist        ── 1:many ── PlaylistTrack (trackId, title, artist, album, coverUrl, position)
StoredTrack     ── global file cache (trackId + bitrate unique), shared across users; storagePath tracks/{trackId}/{bitrate}{ext}
                   for new copies; requestedBitrate = the licence-capped quality asked for when it was persisted
                ── 1:many ── SharedTrack
PersistLease    ── (trackId, bitrate) lease of an in-flight progressive persist, expiresAt-based takeover
SharedTrack     ── public share links (shareId unique; one per userId + trackId), optional expiresAt (expired links purged after 30 days), play counter
Album / AlbumTrack, SavedTrack, RecentPlay ── per-user library; they ref-count StoredTrack files (see library.ts)
DailyMix        ── the user's Daily Mix of the day (one row per user: day + JSON payload), replaced on the next day
ListenEvent     ── append-only listening log, one row per play (msPlayed, endReason, client, shuffle) — recommendation
                   signals; never capped, never anchors files (RecentPlay stays the capped UI history)
TrackMatch      ── Spotify → Deezer match cache
Verification    ── better-auth verification tokens
```

## Conventions

- API routes live in `src/app/api/v1/` (versioned). The legacy non-v1 routes are gone; only `src/app/api/auth/[...all]` (better-auth) sits outside v1.
- State management: Zustand stores in `src/stores/`
- UI components: shadcn/ui in `src/components/ui/`, app components alongside their feature
- Wavelet core logic is self-contained in `src/lib/wavelet/` — modify carefully
- Storage is abstracted via StorageProvider interface (`src/lib/wavelet/storage/`)

## Token-Optimized Navigation

Many internal files are in `.claudeignore` to save tokens. Only **entry points** are indexed.

### Always visible (entry points)
| Module | Visible files | Purpose |
|--------|--------------|---------|
| wavelet | `index.ts`, `settings.ts`, `decryption.ts`, `stripe.ts`, `progressive-stream.ts`, `tagger.ts` | Streaming engine |
| wavelet/types | `index.ts`, `Track.ts`, `Album.ts` | Domain models |
| wavelet/storage | `index.ts`, `StorageProvider.ts`, `factory.ts`, `objects.ts`, `r2.ts`, `R2StorageProvider.ts`, `cached-copy.ts`, `persist-lease.ts`, `gc.ts` | Storage abstraction + Cloudflare R2 |
| wavelet/config-store | `index.ts`, `ConfigStore.ts` | Config abstraction |
| deezer | `index.ts`, `http.ts`, `deezer.ts`, `api.ts`, `gw.ts` | Deezer API client |
| components/ui | `cover-image.tsx` only | Custom UI (shadcn primitives ignored) |

### Ignored (read on-demand when modifying)
- `wavelet/utils/*` — internal helpers (crypto, paths, bitrate, images)
- `wavelet/config-store/PostgresConfigStore.ts` — concrete implementation (Prisma)
- `wavelet/types/{Artist,Playlist,Lyrics,Picture,CustomDate,listener,Settings}.ts` — secondary models
- `wavelet/errors.ts`, `deezer/{types,utils,errors,store,schema/*}.ts` — internals
- `components/ui/*.tsx` — shadcn generated primitives
