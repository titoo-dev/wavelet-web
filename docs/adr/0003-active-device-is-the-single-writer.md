# The Active Device is the only writer of the Playback Session; Remotes send Commands

A Remote never edits the Playback Session itself. It sends a Command (pause, next, seek, add to queue, set volume…), which the Active Device consumes, carries out on its real player, and answers by publishing the resulting state. The published state is therefore always what actually comes out of the speakers: a track the Active Device cannot play (licence refusal, stream failure) never shows as playing, and two Remotes pressing Next at once cannot race. Remotes may show an optimistic state until the Active Device publishes. With no Active Device, any Device writes the Playback Session directly, and its next Play makes it the Active Device.

## Considered Options

- **Every Device writes the state, the Active Device reacts to changes** — simpler at first, but the state can claim a track is playing when the Active Device failed to play it, and concurrent edits race.
- **Convex mutations compute the new state (queue index, shuffle order)** — the queue logic would exist three times: Convex, the web `usePlayerStore`, and the Dart player.

## Consequences

- A Command sent to an Active Device that has just dropped goes unanswered; Remotes need a timeout that falls back to "no Active Device".
