# Convex holds the Playback Session and Devices only; Postgres stays the source of truth

Multi-device playback (Spotify Connect-like) needs state that every Device sees change live: the Playback Session (track, queue, position, play / pause, Active Device) and which Devices are online. Vercel Functions cannot hold WebSockets, so we add Convex for this realtime state only. Library, playlists, auth, StoredTrack and everything else stay in Postgres (Neon, Prisma); Convex references users by their better-auth `userId` and duplicates no Postgres data.

## Considered Options

- **Move the library and playlists to Convex too** — realtime everywhere, but rewrites most of the locked-in, tested surface for a feature that only needs playback state.
- **Convex as a pure message bus** (commands only, state kept in each client) — loses the Playback Session when the Active Device drops, so nobody could resume at the last known position.

## Consequences

- Two databases: a Playback Session can name a `trackId` that Postgres knows nothing about (e.g. a Deezer track never saved). Convex stores the display metadata it needs (title, artist, cover, duration) alongside the `trackId`.
- Background jobs keep using `after()` and Vercel Cron, plus Convex's own scheduler for Convex-side work; Inngest is introduced only if a durable job appears that neither covers.
