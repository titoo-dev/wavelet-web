# Wavelet

Music streaming app with a web client and a mobile client. A listener can see every place they are signed in and choose which of them plays the sound, then control that playback from any of the others.

## Language

### Devices and playback

**Device**:
One running, signed-in instance of a Wavelet client: a browser tab, the Android app or the iOS app. Two tabs of the same browser are two **Devices**; reloading a tab keeps the same **Device**, duplicating it makes a new one.
_Avoid_: Channel, platform (as the unit), client, session

**Platform**:
The kind of client a **Device** runs on (web, android, ios). An attribute of a **Device**, never the unit you pick in "play on…".
_Avoid_: Channel

**Playback Session**:
The one shared listening state of a user: the current track, the queue, the position, play / pause, shuffle and repeat. A user has exactly one **Playback Session**, whichever **Device** they look at. Its tracks are Deezer tracks named by their id; each **Device** finds its own way to play them (download, cached copy, live stream). Volume, crossfade, gapless, normalization and quality are not part of it: they belong to each **Device** (a **Remote** can still change the **Active Device**'s volume).
_Avoid_: Player state, stream, session (bare — clashes with the sign-in session)

**Active Device**:
The single **Device** that outputs the sound of the **Playback Session**, or none. A **Device** becomes active through a **Transfer**, or by pressing Play while there is no **Active Device**; the previous one then falls silent.
_Avoid_: Playing device, host, master

**Remote**:
Any **Device** that is not the **Active Device**: it shows the **Playback Session** and its controls act on the **Active Device**, without playing sound itself. Opening a client never takes over playback on its own.
_Avoid_: Controller, follower, slave

**Transfer**:
The explicit act of choosing another **Device** as the **Active Device**, from the device picker. It is the only way to move the sound: pressing Play on a **Remote** plays on the current **Active Device**. A **Transfer** moves the sound, not the intent: a paused **Playback Session** stays paused, a playing one carries on from the same position.
_Avoid_: Switch, handoff, cast

**Command**:
A request from a **Remote** to the **Active Device** (pause, next, seek, add to queue, set volume…). Only the **Active Device** changes the **Playback Session**: it carries out the **Command** on its real player, then publishes the result. With no **Active Device**, a **Device** changes the **Playback Session** directly.
_Avoid_: Action, event, message

**Online Device**:
A **Device** that has shown a sign of life recently enough to appear in the device picker. An **Active Device** that stops being online is dropped: the **Playback Session** is left paused at its last known position with no **Active Device**, and the next Play on any **Device** makes that one active. When a dropped **Device** comes back: if another **Device** became active meanwhile, it stops and becomes a **Remote**; otherwise it becomes active again and its local state replaces the **Playback Session**. The last **Device** named active wins.
_Avoid_: Connected, available

**Activated Device**:
An **Online Device** that is allowed to output sound right now. Native apps always are; a browser tab becomes one after its first click or key press. Any **Online Device** can be picked for a **Transfer**: a tab that is not yet an **Activated Device** is listed with a hint, and if its browser refuses to play it pauses and asks for a click ("Click to play here").
_Avoid_: Ready, unlocked

### Outside the Playback Session

**Preview**:
A short excerpt played on the **Device** where it was started, never part of the **Playback Session**. Starting one on a **Remote** pauses the **Active Device**, which stays paused when the **Preview** ends.
_Avoid_: Snippet, sample, extract

**Share Player**:
The public player behind a share link. Its listener may be signed out, so it is never a **Device** and never touches a **Playback Session**.

### Lyrics Stories

**Lyrics Range**:
A run of consecutive synced lyric lines of one track, picked by a listener, lasting 5 to 60 seconds. It is chosen by whole lines, never by free timestamps; a track without synced lyrics has no **Lyrics Range**.
_Avoid_: Selection, snippet, extract, clip

**Lyrics Story**:
A short vertical video of a **Lyrics Range**: the matching audio excerpt with its lines appearing in time, the title and the artist, in one **Story Theme**. It is made to be posted to Instagram, Facebook or TikTok stories, and it carries no share link.
_Avoid_: Clip, reel, lyric video, story (bare)

**Story Theme**:
One visual layout a **Lyrics Story** can be rendered in (Blurred Cover, Palette, Minimal, Vinyl). The listener picks it; the track's cover feeds it.
_Avoid_: Template, skin, style

**Theme Still**:
A still image of a **Lyrics Range** in one **Story Theme**, shown while the listener picks a theme. It comes from the same drawing as the **Lyrics Story**, so what they pick is what they get.
_Avoid_: Preview (that is the audio excerpt), thumbnail, mock-up

**Story Render**:
One request to turn a **Lyrics Range** and a **Story Theme** into a **Lyrics Story**, from queued to ready or failed. A ready one can be downloaded for 24 hours, then it is gone; asking again for the same track, range and theme within that time returns the same **Story Render**.
_Avoid_: Export, job (bare), video (for the request)

## Relationships

- A user has one **Playback Session** and many **Devices**.
- A **Playback Session** has zero or one **Active Device**; every other **Online Device** is a **Remote**.
- A **Remote** sends **Commands**; the **Active Device** carries them out and publishes the **Playback Session**.
- A **Lyrics Range** and a **Story Theme** make one **Story Render**, which produces one **Lyrics Story**. Listening to the **Lyrics Range** before rendering is a **Preview**.
- A **Lyrics Story** is not a share link: the **Share Player** never shows it, and a **Lyrics Story** never links to one.

## Example dialogue

> **Dev:** The web tab is open while the phone plays. If I click Play on an album in the tab, does the tab start playing?
> **Domain expert:** No. The tab is a **Remote**: Play becomes a **Command**, and the album plays on the phone, the **Active Device**. To hear it on the computer you **Transfer** to the tab.
> **Dev:** And if the phone loses the network on the way?
> **Domain expert:** Once it is no longer an **Online Device**, the **Playback Session** has no **Active Device**: paused at the last known position. Play in the tab makes the tab active. If the phone comes back afterwards, it falls silent and becomes a **Remote**.
> **Dev:** And a **Preview** on the tab during all this?
> **Domain expert:** It plays in the tab, stays out of the **Playback Session**, and pauses the phone so there aren't two sounds at once.

## Flagged ambiguities

- "Multi channel" was used for the Spotify Connect-like feature. "Channel" is dropped; the unit is the **Device**, and web / mobile is its **Platform**.
- "Session" alone means the sign-in session (better-auth). The listening state is always the **Playback Session**.
- "Story" alone is ambiguous between the social-network post and our video. Ours is always a **Lyrics Story**; the image shown while picking a theme is a **Theme Still**, never a "preview", which is reserved for the audio **Preview**.
