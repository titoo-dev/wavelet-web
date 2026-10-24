---
status: accepted
---

# Lyrics Stories render in a Vercel Function, as a Story Render tracked in Postgres

A Lyrics Story is an MP4 (1080×1920, 30 fps, H.264 + AAC) made on the server: frames drawn in Node, then encoded by a bundled ffmpeg binary, inside a Vercel Function. `POST` creates a Story Render row in Postgres and answers right away. The render then runs in `after()` within the route's `maxDuration` (300 s), the client polls the row, and the ready MP4 is downloaded from R2 through a presigned URL. We stay on Vercel because a Lyrics Story is at most 30 s long and is expected to render in well under the function budget. That keeps the "everything runs inside Next.js" rule (docs/vercel.md) and adds no new infra to run or pay for.

## Considered Options

- **A container worker (Cloud Run with ffmpeg)**: no 300 s ceiling and more CPU. But it is a second deploy target, with its own auth to R2 and Deezer and its own bill, for a feature capped at 30 s. Stem separation was removed for the opposite reason: its jobs did not fit a function.
- **Remotion on AWS Lambda**: themes written in React and rich animation. But it needs an AWS account, may need a Remotion licence depending on usage, and puts a third cloud in the path.
- **A synchronous request that streams the MP4 back**: simpler, but a dropped mobile connection loses a 30–90 s render, and there would be no progress or notification.
- **Rendering on the phone (ffmpeg-kit)**: no server cost. But the themes would be drawn in Dart, apart from the web, ffmpeg-kit is no longer maintained, and the app would grow by tens of MB.

## Consequences

- The function bundle carries an ffmpeg binary and a native canvas library. It must stay under Vercel's 250 MB limit, and the whole route is pinned to the Node.js runtime.
- `after()` is not durable. A render cut off by a crash or a timeout leaves its row in "rendering", so GC marks rows stuck for longer than `maxDuration` as failed. If renders ever outgrow the budget, this ADR is revisited (720p, then a worker) instead of being stretched.
- A spike gated the feature: one 30 s render on a Preview deployment had to finish in under 120 s and fit in memory. It passed on 2026-10-24 (branch `spike/story-render`, iad1, 2 vCPU):

  | Run | Total time | Peak RSS | MP4 size |
  |---|---|---|---|
  | 1080×1920, x264 `veryfast`, cold | 41.9 s | 164 MB | 1.8 MB |
  | 1080×1920, x264 `veryfast`, warm | 40.6 s | 170 MB | 1.8 MB |
  | 720×1280, x264 `veryfast` | 20.9 s | 177 MB | 1.4 MB |
  | 1080×1920, x264 `ultrafast` | 34.9 s | 195 MB | 5.8 MB |

  - Frames come from @napi-rs/canvas, piped raw RGBA to ffmpeg-static, with real MP3 audio read over HTTP.
  - Drawing takes about 55 % of the time (≈ 25 ms per 1080p frame). Caching the static layers is the first lever, ahead of 720p.
  - The function with ffmpeg and canvas deployed within Vercel's size limit, and the rest of the app's bundle did not grow (20.4 MB).
