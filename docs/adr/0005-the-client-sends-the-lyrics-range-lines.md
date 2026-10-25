---
status: proposed
---

# The client sends the lines of a Lyrics Range; the server does not look the lyrics up again

When it asks for a Story Render or a Theme Still, the client sends the text and the timestamps of the lines it showed. The server neither looks them up again nor stores them. Lyrics are not kept in Postgres: they come from LRCLIB or Deezer through a per-instance memory cache, so a second lookup can return other lines or other timings than those the listener picked. Sending the lines guarantees that the Lyrics Story shows exactly what the listener saw.

## Consequences

- The server treats the lines as untrusted input:
  - between 1 and 60 lines, each at most 200 characters, control characters stripped;
  - timestamps increasing, the whole range 5 to 60 s long and inside the track's duration.
- The text is only drawn into the video, never echoed as HTML.
- A listener can put any text on a Lyrics Story of a real track. We accept this: the Lyrics Story is theirs, it is posted under their own name, and it never shows up on a Wavelet page.
