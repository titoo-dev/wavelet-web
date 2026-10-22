// Generates openapi.json (the API contract consumed by the Flutter app).
// Run: npm run openapi — then npm run openapi:dart to regenerate clients/dart.
// Keep in sync with src/app/api/v1/** whenever a route changes.

import { writeFileSync } from "node:fs";

const ref = (n) => ({ $ref: `#/components/schemas/${n}` });
const str = (extra = {}) => ({ type: "string", ...extra });
const nstr = (extra = {}) => ({ type: "string", nullable: true, ...extra });
const int = (extra = {}) => ({ type: "integer", ...extra });
const nint = (extra = {}) => ({ type: "integer", nullable: true, ...extra });
const bool = (extra = {}) => ({ type: "boolean", ...extra });
const dt = (extra = {}) => ({ type: "string", format: "date-time", ...extra });
const ndt = (extra = {}) => ({ type: "string", format: "date-time", nullable: true, ...extra });
const arr = (items, extra = {}) => ({ type: "array", items, ...extra });
const obj = (properties, required = [], extra = {}) => ({
	type: "object",
	properties,
	...(required.length ? { required } : {}),
	...extra,
});
const freeform = (description) => ({ type: "object", additionalProperties: true, description });

// ── Envelope helpers ──
const envelopes = {};
function env(name, dataSchema) {
	envelopes[name] = obj(
		{ success: bool({ enum: [true] }), data: dataSchema },
		["success", "data"]
	);
	return ref(name);
}
const json = (schema) => ({ "application/json": { schema } });
const okRes = (envName, dataSchema, description = "OK", status = "200") => ({
	[status]: { description, content: json(env(envName, dataSchema)) },
});
const err = (description) => ({ $ref: `#/components/responses/${description}` });
const body = (schema, required = true) => ({ required, content: json(schema) });
const pathParam = (name, description) => ({
	name,
	in: "path",
	required: true,
	description,
	schema: str(),
});
const query = (name, schema, description, required = false) => ({
	name,
	in: "query",
	required,
	description,
	schema,
});

const userAuth = [{ bearerAuth: [] }, { sessionCookie: [] }];
const optionalAuth = [{ bearerAuth: [] }, { sessionCookie: [] }, {}];
const noAuth = [];

// Common error sets
const E_USER = { 401: err("NotAuthenticated"), 500: err("InternalError") };
const E_DEEZER = {
	401: err("NotAuthenticatedOrDeezerLoginFailed"),
	403: err("NoDeezerArl"),
	500: err("InternalError"),
};
const E_GUEST = { 503: err("NoDeezer"), 500: err("InternalError") };
const E_400 = { 400: err("BadRequest") };
const E_404 = { 404: err("NotFound") };

const audioBinary = {
	"audio/mpeg": { schema: { type: "string", format: "binary" } },
	"audio/flac": { schema: { type: "string", format: "binary" } },
};

// ── Schemas ──
const schemas = {
	ErrorResponse: obj(
		{
			success: bool({ enum: [false] }),
			error: obj(
				{
					code: str({
						description: "Machine-readable error code (see `x-error-codes`).",
						example: "NOT_AUTHENTICATED",
					}),
					message: str({ example: "Please sign in to continue." }),
				},
				["code", "message"]
			),
		},
		["success", "error"]
	),

	AuthUser: obj(
		{ id: str(), name: str(), email: str({ format: "email" }), image: nstr({ format: "uri" }) },
		["id", "name", "email"]
	),

	DeezerUser: obj(
		{
			id: { oneOf: [int(), str()], description: "Deezer USER_ID" },
			name: str(),
			picture: str({ description: "Deezer picture hash (build URL via e-cdns-images.dzcdn.net/images/user/{hash}/...)" }),
			can_stream_hq: bool(),
			can_stream_lossless: bool(),
			country: str(),
			language: str(),
			loved_tracks: { oneOf: [int(), str()], description: "Loved-tracks playlist id (may be absent)" },
		},
		[],
		{ description: "Deezer may send extra keys; they are ignored. `license_token` is never returned (it lets anyone request media as this account)." }
	),

	DeezerLoginResult: obj(
		{
			user: ref("DeezerUser"),
			childs: arr(ref("DeezerUser"), { description: "Family / child accounts" }),
			currentChild: int({ description: "Index of the selected account in `childs`" }),
			hasMultipleAccounts: bool(),
		},
		["user", "childs", "currentChild", "hasMultipleAccounts"]
	),

	ChangeAccountResult: obj(
		{ user: ref("DeezerUser"), selectedAccount: int(), childs: arr(ref("DeezerUser")) },
		["user", "selectedAccount", "childs"]
	),

	Settings: freeform(
		"Wavelet engine settings (bitrate, path templates, tagging, …). Key example: `maxBitrate` (1 = MP3 128, 3 = MP3 320, 9 = FLAC). Shape mirrors `src/lib/wavelet/types/Settings.ts`."
	),

	SettingsBundle: obj(
		{
			settings: ref("Settings"),
			defaultSettings: ref("Settings"),
		},
		["settings", "defaultSettings"]
	),

	ConnectStatus: obj(
		{
			authenticated: bool({ description: "A better-auth session is present" }),
			user: { type: "object", allOf: [ref("AuthUser")], nullable: true },
			deezerLoggedIn: bool(),
			deezerUser: { type: "object", allOf: [ref("DeezerUser")], nullable: true },
			deezerAvailable: str({ enum: ["yes", "no", "no-network"] }),
			settings: { ...freeform("Same shape as SettingsBundle, or `{}` if the app is not initialized.") },
		},
		["authenticated", "user", "deezerLoggedIn", "deezerUser", "deezerAvailable", "settings"]
	),

	MessageResult: obj({ message: str() }, ["message"]),

	// Raw Deezer payloads — passed through untouched
	DeezerPage: freeform("Raw Deezer GW page payload (`gw.get_page`). Contains `sections[]` with `items[]`."),
	DeezerApiList: obj(
		{
			data: arr(freeform("Deezer public API object (track / album / artist / playlist)")),
			total: int(),
			next: str({ format: "uri" }),
			prev: str({ format: "uri" }),
		},
		[],
		{ description: "Paginated Deezer public API list (api.deezer.com)." }
	),
	DeezerTracklist: freeform(
		"Raw Deezer GW payload. `type=album` → album page + `tracks[]`; `type=playlist` → playlist page + `tracks[]`; `type=artist` → artist page + `topTracks[]` + `discography`. GW objects use uppercase keys (SNG_ID, ALB_ID, ART_ID, …)."
	),
	DeezerSearchMain: freeform(
		"Merged GW search payload with `TRACK`, `ALBUM`, `ARTIST`, `PLAYLIST`, `TOP_RESULT`, `ORDER`, … Each bucket is `{ data: [], count }`. Items are GW objects (uppercase keys) possibly mixed with public-API objects (lowercase keys) appended for extra coverage."
	),

	SuggestTrack: obj(
		{
			source: str({ enum: ["deezer"] }),
			sourceId: str(),
			deezerTrackId: str(),
			title: str(),
			artists: arr(str()),
			artistId: nstr(),
			album: str(),
			albumId: nstr(),
			durationMs: int(),
			coverUrl: nstr({ format: "uri" }),
		},
		["source", "sourceId", "deezerTrackId", "title", "artists", "artistId", "album", "albumId", "durationMs", "coverUrl"]
	),
	SuggestAlbum: obj(
		{
			source: str({ enum: ["deezer"] }),
			sourceId: str(),
			deezerAlbumId: str(),
			title: str(),
			artists: arr(str()),
			coverUrl: nstr({ format: "uri" }),
		},
		["source", "sourceId", "deezerAlbumId", "title", "artists", "coverUrl"]
	),
	SuggestArtist: obj(
		{
			source: str({ enum: ["deezer"] }),
			sourceId: str(),
			deezerArtistId: str(),
			name: str(),
			imageUrl: nstr({ format: "uri" }),
		},
		["source", "sourceId", "deezerArtistId", "name", "imageUrl"]
	),
	Suggestions: obj(
		{
			tracks: arr(ref("SuggestTrack")),
			albums: arr(ref("SuggestAlbum")),
			artists: arr(ref("SuggestArtist")),
			source: str({ enum: ["deezer"] }),
		},
		["tracks", "albums", "artists", "source"]
	),

	// Library
	TrackMetaInput: obj(
		{
			trackId: str({ description: "Deezer track id", example: "3135556" }),
			title: str(),
			artist: str(),
			album: nstr(),
			albumId: nstr({ description: "Deezer album id" }),
			coverUrl: nstr({ format: "uri" }),
			duration: nint({ description: "Seconds" }),
		},
		["trackId", "title", "artist"]
	),
	SavedTrack: obj(
		{
			id: str(),
			userId: str(),
			trackId: str(),
			title: str(),
			artist: str(),
			album: nstr(),
			albumId: nstr(),
			coverUrl: nstr(),
			duration: nint(),
			savedAt: dt(),
		},
		["id", "userId", "trackId", "title", "artist", "album", "albumId", "coverUrl", "duration", "savedAt"]
	),
	AlbumTrackInput: obj(
		{
			trackId: str(),
			title: str(),
			artist: str(),
			coverUrl: nstr(),
			duration: nint({ description: "Seconds" }),
			trackNumber: nint(),
		},
		["trackId"]
	),
	SaveAlbumInput: obj(
		{
			deezerAlbumId: str(),
			title: str(),
			artist: str(),
			coverUrl: nstr({ format: "uri" }),
			tracks: arr(ref("AlbumTrackInput")),
		},
		["deezerAlbumId", "title", "artist", "tracks"]
	),
	Album: obj(
		{
			id: str({ description: "Internal id (cuid) — use this for /library/albums/{albumId}" }),
			userId: str(),
			deezerAlbumId: str(),
			title: str(),
			artist: str(),
			coverUrl: nstr(),
			trackCount: int(),
			savedAt: dt(),
		},
		["id", "userId", "deezerAlbumId", "title", "artist", "coverUrl", "trackCount", "savedAt"]
	),
	AlbumTrack: obj(
		{
			id: str(),
			albumId: str(),
			trackId: str(),
			title: str(),
			artist: str(),
			coverUrl: nstr(),
			duration: nint(),
			trackNumber: nint(),
		},
		["id", "albumId", "trackId", "title", "artist", "coverUrl", "duration", "trackNumber"]
	),
	AlbumWithTracks: {
		allOf: [ref("Album"), obj({ tracks: arr(ref("AlbumTrack")) }, ["tracks"])],
	},
	FollowArtistInput: obj(
		{ deezerArtistId: str(), name: str(), pictureUrl: nstr({ format: "uri" }) },
		["deezerArtistId", "name"]
	),
	FollowedArtist: obj(
		{
			id: str(),
			userId: str(),
			deezerArtistId: str(),
			name: str(),
			pictureUrl: nstr(),
			followedAt: dt(),
		},
		["id", "userId", "deezerArtistId", "name", "pictureUrl", "followedAt"]
	),
	LibraryStatusInput: obj({
		trackIds: arr(str(), { description: "Deezer track ids to check" }),
		albumIds: arr(str(), { description: "Deezer album ids to check" }),
	}),
	LibraryStatus: obj(
		{
			tracks: arr(str(), { description: "Subset of trackIds that are saved" }),
			albums: arr(str(), { description: "Subset of albumIds that are saved" }),
		},
		["tracks", "albums"]
	),

	// Playlists
	Playlist: obj(
		{
			id: str(),
			userId: str(),
			title: str(),
			description: nstr(),
			coverUrl: nstr(),
			isPublic: bool(),
			createdAt: dt(),
			updatedAt: dt(),
		},
		["id", "userId", "title", "description", "coverUrl", "isPublic", "createdAt", "updatedAt"]
	),
	PlaylistSummary: {
		allOf: [
			ref("Playlist"),
			obj(
				{
					_count: obj({ tracks: int() }, ["tracks"]),
					covers: arr(str(), { description: "Cover URLs of the first 4 tracks" }),
					containsTrack: bool({ description: "Only present when `?trackId=` is passed" }),
				},
				["_count", "covers"]
			),
		],
	},
	PlaylistTrack: obj(
		{
			id: str(),
			playlistId: str(),
			trackId: str(),
			title: str(),
			artist: str(),
			album: nstr(),
			albumId: nstr(),
			coverUrl: nstr(),
			duration: nint(),
			position: int(),
			addedAt: dt(),
		},
		["id", "playlistId", "trackId", "title", "artist", "album", "albumId", "coverUrl", "duration", "position", "addedAt"]
	),
	PlaylistWithTracks: {
		allOf: [ref("Playlist"), obj({ tracks: arr(ref("PlaylistTrack")) }, ["tracks"])],
	},
	CreatePlaylistInput: obj({ title: str({ minLength: 1 }), description: nstr() }, ["title"]),
	UpdatePlaylistInput: obj({ title: str(), description: nstr() }),
	PlaylistTrackInput: obj(
		{
			trackId: str(),
			title: str(),
			artist: str(),
			album: nstr(),
			albumId: nstr(),
			coverUrl: nstr(),
			duration: nint(),
		},
		["trackId"]
	),
	SpotifyImportReport: obj(
		{
			totalSpotify: int(),
			processed: int(),
			matched: int(),
			notFound: arr(
				obj(
					{ spotifyId: str(), title: str(), artist: str(), album: str(), reason: str() },
					["spotifyId", "title", "artist", "album", "reason"]
				)
			),
			truncated: bool({ description: "true when the playlist had more than 1000 tracks" }),
			limited: bool({ description: "true when Spotify only exposed the first 100 tracks of a playlist link (paste track links for the full list)" }),
		},
		["totalSpotify", "processed", "matched", "notFound", "truncated"]
	),
	SpotifyTrack: obj(
		{
			spotifyId: str({ description: "22-char Spotify track id" }),
			title: str(),
			artists: arr(str()),
			album: str(),
			albumId: nstr(),
			durationMs: int(),
			isrc: nstr(),
			coverUrl: nstr(),
		},
		["spotifyId", "title", "artists", "durationMs"]
	),
	SpotifyTrackBatch: obj(
		{
			tracks: arr(ref("SpotifyTrack")),
			failed: arr(str(), { description: "ids Spotify did not return (removed, region-locked)" }),
			rateLimited: arr(str(), { description: "ids not read because Spotify started refusing — retry after a pause" }),
		},
		["tracks", "failed", "rateLimited"]
	),
	SpotifyImportResult: obj(
		{
			playlist: { type: "object", allOf: [ref("Playlist")], nullable: true, description: "null when no track matched" },
			report: ref("SpotifyImportReport"),
		},
		["playlist", "report"]
	),
	SpotifyPlaylist: obj(
		{
			spotifyId: str(),
			title: str(),
			description: str(),
			ownerName: str(),
			coverUrl: nstr(),
			totalTracks: int({ description: "real size of the playlist (tracks is capped at 1000)" }),
			tracks: arr(ref("SpotifyTrack")),
			source: str({ enum: ["api", "embed"] }),
			limited: bool({ description: "true when Spotify only exposed the first 100 tracks" }),
		},
		["spotifyId", "title", "totalTracks", "tracks", "source", "limited"]
	),
	SpotifyMatchResult: obj(
		{
			status: str({ enum: ["matched", "not_found"] }),
			strategy: str({ enum: ["isrc", "advanced", "advanced-clean", "fuzzy"] }),
			confidence: { type: "number", description: "0…1" },
			deezerTrackId: str(),
			title: str(),
			artist: str(),
			album: str(),
			albumId: nstr(),
			coverUrl: nstr(),
			duration: int({ description: "seconds" }),
			reason: str({ description: "why nothing matched (not_found only)" }),
		},
		["status"]
	),
	ImportedTrack: obj(
		{
			trackId: str({ description: "Deezer track id" }),
			title: str(),
			artist: str(),
			album: nstr(),
			albumId: nstr(),
			coverUrl: nstr({ description: "https only" }),
			duration: nint({ description: "seconds" }),
		},
		["trackId", "title", "artist"]
	),

	// Preferences
	UserPreferences: obj(
		{
			playlistSortOrder: str({ enum: ["asc", "desc"] }),
			albumSortOrder: str({ enum: ["asc", "desc"] }),
			preCacheSaved: bool({ description: "Warm the R2 cache when saving a track/album" }),
		},
		[],
		{ additionalProperties: false }
	),

	// Recent plays
	RecentPlay: obj(
		{
			id: str(),
			userId: str(),
			trackId: str(),
			title: str(),
			artist: str(),
			album: nstr(),
			albumId: nstr(),
			coverUrl: nstr(),
			duration: nint(),
			playedAt: dt(),
		},
		["id", "userId", "trackId", "title", "artist", "album", "albumId", "coverUrl", "duration", "playedAt"]
	),
	AutoplayTrack: obj(
		{
			trackId: str({ description: "Deezer track id" }),
			title: str(),
			artist: str(),
			artistId: nstr(),
			album: nstr(),
			albumId: nstr(),
			cover: nstr(),
			duration: nint({ description: "Seconds" }),
		},
		["trackId", "title", "artist", "artistId", "album", "albumId", "cover", "duration"]
	),
	DailyMix: obj(
		{
			day: str({ format: "date", description: "The user's day (YYYY-MM-DD)" }),
			basedOn: str({ enum: ["taste", "flow"], description: "taste: the user's top artists of the day; flow: Deezer's Flow (no history yet)" }),
			artists: arr(str(), { description: "The seed artists' names" }),
			tracks: arr(ref("AutoplayTrack")),
		},
		["day", "basedOn", "artists", "tracks"]
	),
	ListenInput: obj(
		{
			trackId: str({ description: "Deezer track id" }),
			artistId: nstr(),
			albumId: nstr(),
			startedAt: dt({ description: "When the sound started (or this part of the play)" }),
			endedAt: ndt({ description: "Server clock when omitted; capped to now" }),
			msPlayed: int({ minimum: 0, maximum: 86400000, description: "Time actually listened to (seeks and pauses excluded)" }),
			durationMs: nint({ minimum: 1 }),
			endReason: str({
				enum: ["completed", "skipped", "stopped", "failed", "transferred", "closed"],
				description:
					"completed: ran to its end; skipped: the user moved to another track; stopped: playback cleared; failed: could not be played on; transferred: the sound moved to another Device; closed: the page or app went away mid-track.",
			}),
			client: str({ maxLength: 16, description: "web, android, ios…" }),
			shuffle: bool({ default: false }),
			source: nstr({ maxLength: 128, description: "Where the play was started from (radio, playlist…)" }),
		},
		["trackId", "startedAt", "msPlayed", "endReason", "client"]
	),
	RecentPlayInput: obj(
		{
			trackId: str(),
			title: str({ default: "" }),
			artist: str({ default: "" }),
			album: nstr(),
			albumId: nstr(),
			coverUrl: nstr(),
			duration: nint(),
		},
		["trackId"]
	),
	SkipResult: obj({
		kept: bool(),
		reason: str({
			enum: ["already_played", "anchored", "persisting", "recent"],
			description:
				"Why the file was kept: `already_played` (this user logged a real play), `anchored` (saved, in a saved album, shared or recent-played by anyone), `persisting` (a persist of the track is in flight), `recent` (its cached copy is younger than 10 min — another listener may be playing it).",
		}),
		evicted: bool(),
	}, [], { description: "Either `{ kept: true, reason }` or `{ evicted: true }`." }),

	// Lyrics
	Lyrics: obj(
		{
			source: { type: "string", enum: ["lrclib", "deezer"], nullable: true },
			syncedLyrics: nstr({ description: "LRC format (`[mm:ss.xx]line` per line)" }),
			plainLyrics: nstr(),
			instrumental: bool(),
		},
		["source", "syncedLyrics", "plainLyrics", "instrumental"]
	),

	// Shares
	CreateShareInput: obj(
		{
			trackId: str(),
			title: str(),
			artist: str(),
			album: nstr(),
			coverUrl: nstr({ description: "https Deezer artwork (*.dzcdn.net, api.deezer.com); any other URL is dropped" }),
			duration: nint(),
			expiresIn: { type: "number", nullable: true, description: "Hours until expiry, more than 0 and at most 8760 (a year). Null or omitted for a permanent link." },
		},
		["trackId", "title", "artist"]
	),
	SharedTrack: obj(
		{
			id: str(),
			shareId: str({ description: "Public id used in /share/t/{shareId}" }),
			trackId: str(),
			userId: str(),
			title: str(),
			artist: str(),
			album: nstr(),
			coverUrl: nstr(),
			duration: nint(),
			storedTrackId: nstr(),
			expiresAt: ndt(),
			plays: int(),
			createdAt: dt(),
		},
		["id", "shareId", "trackId", "userId", "title", "artist", "album", "coverUrl", "duration", "storedTrackId", "expiresAt", "plays", "createdAt"]
	),
	PublicShare: obj(
		{
			shareId: str(),
			title: str(),
			artist: str(),
			album: nstr(),
			coverUrl: nstr(),
			duration: nint(),
			plays: int(),
			createdAt: dt(),
			expiresAt: ndt(),
			user: obj({ name: str() }, ["name"]),
		},
		["shareId", "title", "artist", "album", "coverUrl", "duration", "plays", "createdAt", "expiresAt", "user"]
	),

	// Streaming
	StreamUrl: obj(
		{
			url: nstr({ format: "uri", description: "Presigned Cloudflare R2 URL, valid 1 h (3600 s, see `expiresAt`). null → see `status`." }),
			contentType: str({ example: "audio/mpeg", description: "Present only when `url` is set" }),
			expiresAt: dt({
				description:
					"Present only when `url` is set. ISO-8601 instant the presigned URL lapses (signing time + 3600 s, never later than the real expiry). Refresh it with this endpoint before then.",
			}),
			status: str({
				enum: ["not_cached", "unsupported_storage", "file_missing", "presigned_disabled"],
				description:
					"Present only when `url` is null. `not_cached`: no usable cached copy (including a copy below this listener's quality, which the progressive play upgrades) → play /stream-progressive. `unsupported_storage`: only copies in older storage → /stream-progressive. `file_missing`: the object is gone from R2 → /stream-progressive. `presigned_disabled`: presigned URLs are turned off server-side (`WAVELET_DISABLE_PRESIGNED_URLS=1`) → play the same-origin /stream.",
			}),
		},
		["url"]
	),
	StreamProbe: obj(
		{
			ok: bool({ enum: [true] }),
			cached: bool({
				description:
					"true when a usable cached copy exists for this listener (a play would 302 to /stream; the object itself is not re-checked in R2). Always false with `live=1`.",
			}),
		},
		["ok", "cached"]
	),
	GcResult: obj(
		{
			ran: bool({ description: "false while `CRON_SECRET` is unset (no work done)" }),
			reason: str({ description: "Only when `ran` is false", example: "CRON_SECRET is not configured" }),
			rowsDeleted: int({ description: "Unreferenced StoredTrack rows deleted (only when `ran` is true)" }),
			objectsDeleted: int({ description: "R2 objects of those rows deleted (only when `ran` is true)" }),
			objectsScanned: int({ description: "Objects listed under `tracks/` (only when `ran` is true)" }),
			orphanObjectsDeleted: int({ description: "Objects under `tracks/` without any row deleted (only when `ran` is true)" }),
			expiredSharesDeleted: int({ description: "Share links expired for more than 30 days deleted (only when `ran` is true)" }),
		},
		["ran"],
		{ description: "`{ ran: false, reason }` or `{ ran: true, rowsDeleted, objectsDeleted, objectsScanned, orphanObjectsDeleted, expiredSharesDeleted }`." }
	),

	// better-auth
	SocialSignInInput: obj(
		{
			provider: str({ enum: ["google"] }),
			callbackURL: str({ description: "Where to land after the OAuth redirect flow (web flow only)" }),
			disableRedirect: bool(),
			idToken: obj(
				{
					token: str({ description: "Google ID token from the native Google Sign-In SDK" }),
					accessToken: str(),
					nonce: str(),
				},
				["token"],
				{ description: "Native mobile flow: no browser redirect, session cookie set directly on the response." }
			),
		},
		["provider"]
	),
	SocialSignInResult: obj(
		{
			redirect: bool(),
			url: str({ format: "uri", description: "Google consent URL (redirect flow)" }),
			token: str({ description: "Session token (idToken flow)" }),
			user: ref("BetterAuthUser"),
		},
		[],
		{ description: "better-auth may send extra keys; they are ignored." }
	),
	BetterAuthUser: obj(
		{
			id: str(),
			name: str(),
			email: str({ format: "email" }),
			emailVerified: bool(),
			image: nstr(),
			createdAt: dt(),
			updatedAt: dt(),
		},
		["id", "name", "email"]
	),
	BetterAuthSession: obj(
		{
			session: obj(
				{
					id: str(),
					userId: str(),
					token: str(),
					expiresAt: dt(),
					createdAt: dt(),
					updatedAt: dt(),
					ipAddress: nstr(),
					userAgent: nstr(),
				},
				["id", "userId", "token", "expiresAt"]
			),
			user: ref("BetterAuthUser"),
		},
		["session", "user"]
	),
};

// ── Paths ──
const paths = {
	// ─── better-auth ───
	"/api/auth/sign-in/social": {
		post: {
			tags: ["Auth (session)"],
			operationId: "signInSocial",
			summary: "Sign in with Google (better-auth)",
			description:
				"Managed by better-auth (not the `{ success, data }` envelope). For Flutter, use the **idToken** flow: get a Google ID token with `google_sign_in` (with the web client ID as `serverClientId`), POST it here, read the `set-auth-token` response header and send it as `Authorization: Bearer <token>` on every subsequent call.",
			security: noAuth,
			requestBody: body(ref("SocialSignInInput")),
			responses: {
				200: {
					description: "Signed in (idToken) or redirect URL returned",
					headers: {
						"set-auth-token": {
							description: "Session token for `Authorization: Bearer` (bearer plugin). Store it securely.",
							schema: str(),
						},
						"Set-Cookie": {
							description: "`__Secure-better-auth.session_token` (+ `session_data` cache cookie)",
							schema: str(),
						},
					},
					content: json(ref("SocialSignInResult")),
				},
				400: { description: "Invalid provider / token" },
				401: { description: "ID token rejected" },
			},
		},
	},
	"/api/auth/get-session": {
		get: {
			tags: ["Auth (session)"],
			operationId: "getSession",
			summary: "Current better-auth session",
			description: "Returns `null` (JSON) when no valid session cookie is sent.",
			security: optionalAuth,
			responses: {
				200: {
					description: "Session or null",
					content: json({ type: "object", allOf: [ref("BetterAuthSession")], nullable: true }),
				},
			},
		},
	},
	"/api/auth/sign-out": {
		post: {
			tags: ["Auth (session)"],
			operationId: "signOut",
			summary: "Sign out (invalidate the session)",
			security: userAuth,
			requestBody: body(obj({}), false),
			responses: {
				200: { description: "Signed out", content: json(obj({ success: bool() })) },
			},
		},
	},

	// ─── Deezer auth ───
	"/api/v1/auth/connect": {
		get: {
			tags: ["Deezer account"],
			operationId: "getConnectStatus",
			summary: "Bootstrap: session + Deezer status + app settings",
			description:
				"Call at app start. Works without auth (guest). When signed in, restores the Deezer session from the stored ARL (or the server's service ARL, which is then persisted for the user).",
			security: optionalAuth,
			responses: { ...okRes("ConnectStatusEnvelope", ref("ConnectStatus")), 500: err("InternalError") },
		},
	},
	"/api/v1/auth/login-arl": {
		post: {
			tags: ["Deezer account"],
			operationId: "loginDeezerArl",
			summary: "Connect a Deezer account with an ARL cookie",
			security: userAuth,
			requestBody: body(
				obj({ arl: str({ description: "Deezer `arl` cookie value" }), child: int({ default: 0, description: "Child account index" }) }, ["arl"])
			),
			responses: {
				...okRes("DeezerLoginEnvelope", ref("DeezerLoginResult")),
				400: err("BadRequest"),
				401: err("NotAuthenticatedOrDeezerLoginFailed"),
				500: err("InternalError"),
			},
			"x-error-codes": ["NOT_AUTHENTICATED", "INVALID_BODY", "MISSING_ARL", "LOGIN_FAILED", "INTERNAL_ERROR"],
		},
	},
	"/api/v1/auth/login-email": {
		post: {
			tags: ["Deezer account"],
			operationId: "loginDeezerEmail",
			summary: "Connect a Deezer account with email/password",
			security: userAuth,
			requestBody: body(obj({ email: str({ format: "email" }), password: str({ format: "password" }) }, ["email", "password"])),
			responses: {
				...okRes("DeezerLoginEnvelope", ref("DeezerLoginResult")),
				400: err("BadRequest"),
				401: err("NotAuthenticatedOrDeezerLoginFailed"),
				500: err("InternalError"),
			},
			"x-error-codes": ["NOT_AUTHENTICATED", "INVALID_BODY", "MISSING_CREDENTIALS", "LOGIN_FAILED", "INTERNAL_ERROR"],
		},
	},
	"/api/v1/auth/change-account": {
		post: {
			tags: ["Deezer account"],
			operationId: "changeDeezerAccount",
			summary: "Switch to another Deezer family/child account",
			description:
				"The session is checked before the body is read (401 / 403 come first). The choice is saved, so a later session restore logs into the same child; if that save fails, the switch is still answered as done.",
			security: userAuth,
			requestBody: body(
				obj({ child: int({ minimum: 0, description: "Index in `childs` — a non-negative integer (a digit string is accepted)" }) }, ["child"])
			),
			responses: { ...okRes("ChangeAccountEnvelope", ref("ChangeAccountResult")), ...E_400, ...E_DEEZER },
			"x-error-codes": ["INVALID_BODY", "MISSING_CHILD_INDEX", "INVALID_CHILD_INDEX", "NOT_AUTHENTICATED", "NO_DEEZER_ARL", "DEEZER_LOGIN_FAILED"],
		},
	},
	"/api/v1/auth/logout": {
		post: {
			tags: ["Deezer account"],
			operationId: "logoutDeezer",
			summary: "Clear the in-memory Deezer session",
			description: "Does not delete the stored ARL nor the better-auth session (use `/api/auth/sign-out`).",
			security: optionalAuth,
			responses: { ...okRes("MessageEnvelope", ref("MessageResult")), 500: err("InternalError") },
		},
	},

	// ─── Content ───
	"/api/v1/content/home": {
		get: {
			tags: ["Browse"],
			operationId: "getHome",
			summary: "Deezer explore page (home feed)",
			security: optionalAuth,
			responses: { ...okRes("DeezerPageEnvelope", ref("DeezerPage")), ...E_GUEST },
		},
	},
	"/api/v1/content/new-releases": {
		get: {
			tags: ["Browse"],
			operationId: "getNewReleases",
			summary: "Editorial new releases (100 max)",
			security: optionalAuth,
			responses: { ...okRes("DeezerApiListEnvelope", ref("DeezerApiList")), ...E_GUEST },
		},
	},
	"/api/v1/content/tracklist": {
		get: {
			tags: ["Browse"],
			operationId: "getTracklist",
			summary: "Album / playlist / artist page with tracks",
			security: optionalAuth,
			parameters: [
				query("id", str({ pattern: "^[0-9]+$" }), "Numeric Deezer id", true),
				query("type", str({ enum: ["album", "playlist", "artist"] }), "Entity type", true),
			],
			responses: { ...okRes("DeezerTracklistEnvelope", ref("DeezerTracklist")), ...E_400, ...E_404, 502: err("UpstreamError"), ...E_GUEST },
			"x-error-codes": ["MISSING_PARAMS", "INVALID_TYPE", "INVALID_ID", "NOT_FOUND", "UPSTREAM_ERROR", "NO_DEEZER"],
		},
	},

	// ─── Search ───
	"/api/v1/search": {
		get: {
			tags: ["Search"],
			operationId: "search",
			summary: "Typed search (Deezer public API)",
			security: optionalAuth,
			parameters: [
				query("term", str(), "Search query", true),
				query("type", str({ enum: ["track", "album", "artist", "playlist"], default: "track" }), "Result type"),
				query("start", int({ default: 0 }), "Offset"),
				query("nb", int({ default: 100 }), "Page size"),
			],
			responses: { ...okRes("DeezerApiListEnvelope", ref("DeezerApiList")), ...E_400, ...E_GUEST },
			"x-error-codes": ["MISSING_TERM", "INVALID_TYPE", "NO_DEEZER"],
		},
	},
	"/api/v1/search/main": {
		get: {
			tags: ["Search"],
			operationId: "searchMain",
			summary: "Global search (all buckets, GW + API merged)",
			security: optionalAuth,
			parameters: [query("term", str(), "Search query", true)],
			responses: { ...okRes("DeezerSearchMainEnvelope", ref("DeezerSearchMain")), ...E_400, ...E_GUEST },
			"x-error-codes": ["MISSING_TERM", "NO_DEEZER"],
		},
	},
	"/api/v1/search/album": {
		get: {
			tags: ["Search"],
			operationId: "searchAlbum",
			summary: "Album search",
			security: optionalAuth,
			parameters: [
				query("term", str(), "Search query", true),
				query("start", int({ default: 0 }), "Offset"),
				query("nb", int({ default: 100 }), "Page size"),
			],
			responses: { ...okRes("DeezerApiListEnvelope", ref("DeezerApiList")), ...E_400, ...E_GUEST },
		},
	},
	"/api/v1/search/suggest": {
		get: {
			tags: ["Search"],
			operationId: "searchSuggest",
			summary: "Autocomplete suggestions (normalized)",
			security: optionalAuth,
			parameters: [
				query("term", str(), "Search query", true),
				query("limit", int({ default: 5, minimum: 1, maximum: 10 }), "Per-bucket limit (clamped 1–10)"),
			],
			responses: { ...okRes("SuggestionsEnvelope", ref("Suggestions")), ...E_400, ...E_GUEST },
		},
	},

	// ─── Library ───
	"/api/v1/library/tracks": {
		get: {
			tags: ["Library"],
			operationId: "listSavedTracks",
			summary: "Liked tracks (most recent first)",
			security: userAuth,
			parameters: [
				query("limit", int({ default: 100, minimum: 1, maximum: 500 }), "Page size (0 / invalid → 100)"),
				query("offset", int({ default: 0, minimum: 0 }), "Offset"),
			],
			responses: { ...okRes("SavedTrackListEnvelope", obj({ items: arr(ref("SavedTrack")) }, ["items"])), ...E_USER },
		},
		post: {
			tags: ["Library"],
			operationId: "saveTrack",
			summary: "Like a track (upsert)",
			security: userAuth,
			requestBody: body(ref("TrackMetaInput")),
			responses: { ...okRes("SavedTrackEnvelope", obj({ saved: ref("SavedTrack") }, ["saved"])), ...E_400, ...E_USER },
			"x-error-codes": ["INVALID_BODY"],
		},
	},
	"/api/v1/library/tracks/{trackId}": {
		parameters: [pathParam("trackId", "Deezer track id")],
		get: {
			tags: ["Library"],
			operationId: "isTrackSaved",
			summary: "Is this track liked?",
			security: userAuth,
			responses: { ...okRes("SavedFlagEnvelope", obj({ saved: bool() }, ["saved"])), ...E_USER },
		},
		delete: {
			tags: ["Library"],
			operationId: "unsaveTrack",
			summary: "Unlike a track (idempotent)",
			security: userAuth,
			responses: { ...okRes("UnsavedEnvelope", obj({ unsaved: bool({ enum: [true] }) }, ["unsaved"])), ...E_USER },
		},
	},
	"/api/v1/library/albums": {
		get: {
			tags: ["Library"],
			operationId: "listSavedAlbums",
			summary: "Saved albums",
			security: userAuth,
			responses: { ...okRes("AlbumListEnvelope", obj({ items: arr(ref("Album")) }, ["items"])), ...E_USER },
		},
		post: {
			tags: ["Library"],
			operationId: "saveAlbum",
			summary: "Save an album with its tracklist (upsert, re-syncs tracks)",
			security: userAuth,
			requestBody: body(ref("SaveAlbumInput")),
			responses: { ...okRes("SavedAlbumEnvelope", obj({ saved: ref("Album") }, ["saved"])), ...E_400, ...E_USER },
			"x-error-codes": ["INVALID_BODY"],
		},
	},
	"/api/v1/library/albums/{albumId}": {
		parameters: [pathParam("albumId", "Internal Album.id (cuid), NOT the Deezer album id")],
		get: {
			tags: ["Library"],
			operationId: "getSavedAlbum",
			summary: "Saved album with tracklist",
			security: userAuth,
			responses: { ...okRes("AlbumWithTracksEnvelope", ref("AlbumWithTracks")), ...E_404, ...E_USER },
		},
		delete: {
			tags: ["Library"],
			operationId: "unsaveAlbum",
			summary: "Remove a saved album",
			security: userAuth,
			responses: { ...okRes("UnsavedEnvelope", obj({ unsaved: bool({ enum: [true] }) }, ["unsaved"])), ...E_404, ...E_USER },
		},
	},
	"/api/v1/library/artists": {
		get: {
			tags: ["Library"],
			operationId: "listFollowedArtists",
			summary: "Followed artists",
			security: userAuth,
			responses: { ...okRes("FollowedArtistListEnvelope", obj({ items: arr(ref("FollowedArtist")) }, ["items"])), ...E_USER },
		},
		post: {
			tags: ["Library"],
			operationId: "followArtist",
			summary: "Follow an artist (upsert)",
			security: userAuth,
			requestBody: body(ref("FollowArtistInput")),
			responses: { ...okRes("FollowedArtistEnvelope", obj({ followed: ref("FollowedArtist") }, ["followed"])), ...E_400, ...E_USER },
			"x-error-codes": ["INVALID_BODY"],
		},
	},
	"/api/v1/library/artists/{deezerArtistId}": {
		parameters: [pathParam("deezerArtistId", "Deezer artist id")],
		delete: {
			tags: ["Library"],
			operationId: "unfollowArtist",
			summary: "Unfollow an artist (idempotent)",
			security: userAuth,
			responses: { ...okRes("UnfollowedEnvelope", obj({ unfollowed: bool({ enum: [true] }) }, ["unfollowed"])), ...E_USER },
		},
	},
	"/api/v1/library/status": {
		post: {
			tags: ["Library"],
			operationId: "getLibraryStatus",
			summary: "Batch: which of these tracks/albums are saved?",
			description: "Non-array `trackIds` / `albumIds` are silently treated as `[]`.",
			security: userAuth,
			requestBody: body(ref("LibraryStatusInput")),
			responses: { ...okRes("LibraryStatusEnvelope", ref("LibraryStatus")), ...E_USER },
		},
	},

	// ─── Playlists ───
	"/api/v1/playlists": {
		get: {
			tags: ["Playlists"],
			operationId: "listPlaylists",
			summary: "User playlists (most recently updated first)",
			security: userAuth,
			parameters: [query("trackId", str(), "If set, each playlist gets `containsTrack`")],
			responses: { ...okRes("PlaylistSummaryListEnvelope", arr(ref("PlaylistSummary"))), ...E_USER },
		},
		post: {
			tags: ["Playlists"],
			operationId: "createPlaylist",
			summary: "Create a playlist",
			security: userAuth,
			requestBody: body(ref("CreatePlaylistInput")),
			responses: { ...okRes("PlaylistEnvelope", ref("Playlist")), ...E_400, ...E_USER },
			"x-error-codes": ["MISSING_TITLE"],
		},
	},
	"/api/v1/playlists/{id}": {
		parameters: [pathParam("id", "Playlist id")],
		get: {
			tags: ["Playlists"],
			operationId: "getPlaylist",
			summary: "Playlist with tracks (ordered by position)",
			security: userAuth,
			responses: { ...okRes("PlaylistWithTracksEnvelope", ref("PlaylistWithTracks")), ...E_404, ...E_USER },
		},
		patch: {
			tags: ["Playlists"],
			operationId: "updatePlaylist",
			summary: "Rename / edit description",
			security: userAuth,
			requestBody: body(ref("UpdatePlaylistInput")),
			responses: { ...okRes("PlaylistEnvelope", ref("Playlist")), ...E_404, ...E_USER },
		},
		delete: {
			tags: ["Playlists"],
			operationId: "deletePlaylist",
			summary: "Delete a playlist",
			security: userAuth,
			responses: { ...okRes("DeletedEnvelope", obj({ deleted: bool({ enum: [true] }) }, ["deleted"])), ...E_404, ...E_USER },
		},
	},
	"/api/v1/playlists/{id}/tracks": {
		parameters: [pathParam("id", "Playlist id")],
		post: {
			tags: ["Playlists"],
			operationId: "addPlaylistTracks",
			summary: "Append track(s) (duplicates skipped)",
			security: userAuth,
			requestBody: body(obj({ tracks: arr(ref("PlaylistTrackInput"), { minItems: 1 }) }, ["tracks"])),
			responses: { ...okRes("AddedEnvelope", obj({ added: int() }, ["added"])), ...E_400, ...E_404, ...E_USER },
			"x-error-codes": ["MISSING_TRACKS", "NOT_FOUND"],
		},
		patch: {
			tags: ["Playlists"],
			operationId: "reorderPlaylistTracks",
			summary: "Reorder tracks",
			description: "`trackIds` must contain exactly the playlist's current trackIds in the new order.",
			security: userAuth,
			requestBody: body(obj({ trackIds: arr(str()) }, ["trackIds"])),
			responses: { ...okRes("ReorderedEnvelope", obj({ reordered: int() }, ["reordered"])), ...E_400, ...E_404, ...E_USER },
			"x-error-codes": ["MISSING_TRACK_IDS", "REORDER_LENGTH_MISMATCH", "REORDER_DUPLICATE_TRACK", "REORDER_UNKNOWN_TRACK"],
		},
		delete: {
			tags: ["Playlists"],
			operationId: "removePlaylistTracks",
			summary: "Remove track(s)",
			description: "⚠ DELETE with a JSON body. Make sure your HTTP client sends it (Dio does with `data:`).",
			security: userAuth,
			requestBody: body(obj({ trackIds: arr(str(), { minItems: 1 }) }, ["trackIds"])),
			responses: { ...okRes("RemovedEnvelope", obj({ removed: int() }, ["removed"])), ...E_400, ...E_404, ...E_USER },
			"x-error-codes": ["MISSING_TRACK_IDS", "NOT_FOUND"],
		},
	},
	"/api/v1/playlists/import/spotify": {
		post: {
			tags: ["Playlists"],
			operationId: "importSpotifyPlaylist",
			summary: "Import a Spotify playlist (matched to Deezer, max 1000 tracks)",
			description: "Synchronous; can take a couple of minutes on large playlists — use a long client timeout, or the chunked flow: POST /playlists/import/spotify/playlist (or …/tracks), then …/match in batches of 50, then …/save.",
			security: userAuth,
			requestBody: body({
				oneOf: [
					obj({ url: str({ description: "Spotify playlist URL, URI or id (first 100 tracks without API access)", example: "https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M" }) }, ["url"]),
					obj(
						{
							tracks: arr(ref("SpotifyTrack"), { minItems: 1, description: "tracks read with POST /playlists/import/spotify/tracks" }),
							unreadable: arr(str(), { description: "track ids that could not be read (reported as not found)" }),
							total: int({ description: "number of pasted links, for the truncated flag" }),
							title: str({ description: "name of the new playlist (default \"Spotify import\")" }),
						},
						["tracks"]
					),
				],
			}),
			responses: {
				...okRes("SpotifyImportEnvelope", ref("SpotifyImportResult")),
				400: err("BadRequest"),
				403: err("Forbidden"),
				404: err("NotFound"),
				429: err("RateLimited"),
				502: err("UpstreamError"),
				...E_DEEZER,
			},
			"x-error-codes": [
				"MISSING_URL", "INVALID_URL", "INVALID_TRACKS", "EMPTY_PLAYLIST", "SPOTIFY_NOT_FOUND",
				"SPOTIFY_FORBIDDEN", "SPOTIFY_RATE_LIMITED", "SPOTIFY_ERROR", "NO_DEEZER_ARL", "DEEZER_LOGIN_FAILED",
			],
		},
	},

	"/api/v1/playlists/import/spotify/tracks": {
		post: {
			tags: ["Playlists"],
			operationId: "readSpotifyTracks",
			summary: "Read up to 50 Spotify tracks from their public pages",
			description: "Step 1 of importing pasted track links. Call in batches; when `rateLimited` is non-empty, pause (20 s, then longer) and resend those ids, then send all tracks to POST /playlists/import/spotify.",
			security: userAuth,
			requestBody: body(obj({ ids: arr(str(), { minItems: 1, maxItems: 50 }) }, ["ids"])),
			responses: { ...okRes("SpotifyTrackBatchEnvelope", ref("SpotifyTrackBatch")), ...E_400, ...E_USER },
			"x-error-codes": ["INVALID_IDS", "TOO_MANY_IDS"],
		},
	},
	"/api/v1/playlists/import/spotify/playlist": {
		post: {
			tags: ["Playlists"],
			operationId: "readSpotifyPlaylist",
			summary: "Read a public Spotify playlist (no matching)",
			description: "Step 1 of the chunked import from a playlist link. `tracks` is capped at 1000; `totalTracks` keeps the real count.",
			security: userAuth,
			requestBody: body(obj({ url: str({ description: "Spotify playlist URL, URI or id" }) }, ["url"])),
			responses: {
				...okRes("SpotifyPlaylistEnvelope", ref("SpotifyPlaylist")),
				400: err("BadRequest"),
				403: err("Forbidden"),
				404: err("NotFound"),
				429: err("RateLimited"),
				502: err("UpstreamError"),
				...E_USER,
			},
			"x-error-codes": ["MISSING_URL", "INVALID_URL", "EMPTY_PLAYLIST", "SPOTIFY_NOT_FOUND", "SPOTIFY_FORBIDDEN", "SPOTIFY_RATE_LIMITED", "SPOTIFY_ERROR"],
		},
	},
	"/api/v1/playlists/import/spotify/match": {
		post: {
			tags: ["Playlists"],
			operationId: "matchSpotifyTracks",
			summary: "Match up to 50 Spotify tracks on Deezer",
			description: "Step 2 of the chunked import. `results` is in the order of `tracks`; send the matched ones to POST /playlists/import/spotify/save.",
			security: userAuth,
			requestBody: body(obj({ tracks: arr(ref("SpotifyTrack"), { minItems: 1, maxItems: 50 }) }, ["tracks"])),
			responses: { ...okRes("SpotifyMatchEnvelope", obj({ results: arr(ref("SpotifyMatchResult")) }, ["results"])), ...E_400, ...E_DEEZER },
			"x-error-codes": ["INVALID_TRACKS", "TOO_MANY_TRACKS", "NO_DEEZER_ARL", "DEEZER_LOGIN_FAILED"],
		},
	},
	"/api/v1/playlists/import/spotify/save": {
		post: {
			tags: ["Playlists"],
			operationId: "saveSpotifyImport",
			summary: "Create the imported playlist from matched tracks",
			description: "Step 3 of the chunked import. Duplicate track ids are dropped.",
			security: userAuth,
			requestBody: body(
				obj(
					{
						title: str({ description: "default \"Spotify import\"" }),
						description: str(),
						coverUrl: nstr({ description: "https only; else the first track's cover" }),
						tracks: arr(ref("ImportedTrack"), { minItems: 1, maxItems: 1000 }),
					},
					["tracks"]
				)
			),
			responses: { ...okRes("SpotifySaveEnvelope", obj({ playlist: ref("Playlist") }, ["playlist"])), ...E_400, ...E_USER },
			"x-error-codes": ["INVALID_TRACKS", "TOO_MANY_TRACKS"],
		},
	},

	// ─── Preferences / settings ───
	"/api/v1/preferences": {
		get: {
			tags: ["Settings"],
			operationId: "getPreferences",
			summary: "UI preferences",
			security: userAuth,
			responses: { ...okRes("UserPreferencesEnvelope", ref("UserPreferences")), ...E_USER },
		},
		patch: {
			tags: ["Settings"],
			operationId: "updatePreferences",
			summary: "Merge UI preferences (unknown keys → 400)",
			security: userAuth,
			requestBody: body(ref("UserPreferences")),
			responses: { ...okRes("UserPreferencesEnvelope", ref("UserPreferences")), ...E_400, ...E_USER },
			"x-error-codes": ["INVALID_KEY"],
		},
	},
	"/api/v1/settings": {
		get: {
			tags: ["Settings"],
			operationId: "getSettings",
			summary: "Engine settings (per-user overrides merged over global)",
			description: "Signed in with stored overrides → `settings` is the global settings with the user's overrides merged on top; otherwise the global settings.",
			security: optionalAuth,
			responses: { ...okRes("SettingsBundleEnvelope", ref("SettingsBundle")), 500: err("InternalError") },
		},
		post: {
			tags: ["Settings"],
			operationId: "saveSettings",
			summary: "Save the signed-in user's engine settings",
			description:
				"`settings` replaces the user's stored overrides (null → `{}`, i.e. back to the global settings; a body without `settings` is a 400 INVALID_BODY so it never wipes them by accident). Server-wide settings are never written here (the streaming quality has its own route). A `spotifySettings` field is ignored. The response's `settings` is the object as sent (not merged over the global settings), or the global settings when none was sent.",
			security: userAuth,
			requestBody: body(obj({ settings: { type: "object", allOf: [ref("Settings")], nullable: true } }, ["settings"])),
			responses: { ...okRes("SettingsBundleEnvelope", ref("SettingsBundle")), ...E_400, ...E_USER },
			"x-error-codes": ["NOT_AUTHENTICATED", "INVALID_BODY"],
		},
	},
	"/api/v1/settings/quality": {
		get: {
			tags: ["Settings"],
			operationId: "getStreamingQuality",
			summary: "Server-wide streaming quality (maxBitrate)",
			description: "The one `maxBitrate` every stream uses (1 = MP3 128, 3 = MP3 320, 9 = FLAC). Per-user `settings.maxBitrate` is not used for streaming.",
			security: optionalAuth,
			responses: { ...okRes("StreamingQualityEnvelope", obj({ maxBitrate: int({ enum: [1, 3, 9] }) }, ["maxBitrate"])), 500: err("InternalError") },
		},
		post: {
			tags: ["Settings"],
			operationId: "setStreamingQuality",
			summary: "Change the server-wide streaming quality",
			description:
				"Applies to every listener. Tracks already cached keep the bitrate they were stored in. When `WAVELET_ADMIN_EMAILS` is set (comma-separated, case-insensitive), only those accounts may change it — anyone else gets 403 `FORBIDDEN`; when it is unset or empty, any signed-in user may.",
			security: userAuth,
			requestBody: body(obj({ maxBitrate: int({ enum: [1, 3, 9] }) }, ["maxBitrate"])),
			responses: {
				...okRes("StreamingQualityEnvelope", obj({ maxBitrate: int({ enum: [1, 3, 9] }) }, ["maxBitrate"])),
				...E_400,
				403: err("Forbidden"),
				...E_USER,
			},
			"x-error-codes": ["NOT_AUTHENTICATED", "FORBIDDEN", "INVALID_BITRATE", "INVALID_BODY"],
		},
	},

	// ─── Recent plays ───
	"/api/v1/recent-plays": {
		get: {
			tags: ["Recent plays"],
			operationId: "listRecentPlays",
			summary: "Listening history (most recent first, cap 100)",
			security: userAuth,
			parameters: [query("limit", int({ default: 50, minimum: 1, maximum: 100 }), "Page size (0 / invalid → 50)")],
			responses: { ...okRes("RecentPlayListEnvelope", obj({ items: arr(ref("RecentPlay")) }, ["items"])), ...E_USER },
		},
		post: {
			tags: ["Recent plays"],
			operationId: "logRecentPlay",
			summary: "Log a play — call after 30 s of continuous playback",
			security: userAuth,
			requestBody: body(ref("RecentPlayInput")),
			responses: { ...okRes("LoggedEnvelope", obj({ logged: bool({ enum: [true] }) }, ["logged"])), ...E_400, ...E_USER },
			"x-error-codes": ["INVALID_BODY"],
		},
	},
	"/api/v1/recent-plays/{trackId}/skip": {
		parameters: [pathParam("trackId", "Deezer track id")],
		post: {
			tags: ["Recent plays"],
			operationId: "reportSkip",
			summary: "Report a skip before 30 s (lets the server free the cached file)",
			description:
				"The file is kept (`{ kept: true, reason }`) when this user already logged a real play (`already_played`), anything else references the track (`anchored`), a persist of it is in flight (`persisting`) or its cached copy is younger than 10 min (`recent`). Otherwise it is freed (`{ evicted: true }`); the metadata in saved-* tables stays, so a replay re-streams.",
			security: userAuth,
			responses: { ...okRes("SkipEnvelope", ref("SkipResult")), ...E_USER },
		},
	},

	// ─── Autoplay ───
	"/api/v1/autoplay": {
		post: {
			tags: ["Listens"],
			operationId: "autoplay",
			summary: "Tracks to append once the queue runs out (similar to the seeds)",
			description:
				"Mixes Deezer's radios of up to 3 seed artists (most recent seed first) with ListenBrainz / Last.fm tracks similar to the first seed (found back on Deezer). Leaves out the seeds, `exclude`, the tracks this user skips early more often than they listen to them, the artists they skipped early 3 times and never listened to, and anything played in the last 3 hours; at most 2 tracks per artist, never one artist twice in a row when it can be helped. Call it when the last track of the queue starts, and append with `source: \"autoplay\"`.",
			security: userAuth,
			requestBody: body(
				obj(
					{
						seeds: arr(obj({ trackId: str(), artistId: nstr({ description: "Looked up when missing" }) }, ["trackId"]), {
							minItems: 1,
							maxItems: 5,
							description: "Most recent first: the track playing, then the ones before it",
						}),
						exclude: arr(str(), { maxItems: 1000, description: "Track ids already queued" }),
						limit: int({ minimum: 1, maximum: 50, default: 20 }),
					},
					["seeds"]
				)
			),
			responses: {
				...okRes("AutoplayEnvelope", obj({ tracks: arr(ref("AutoplayTrack")), seedArtistIds: arr(str()) }, ["tracks", "seedArtistIds"])),
				...E_400,
				...E_404,
				502: err("DeezerUpstreamError"),
				503: err("NoDeezer"),
				...E_USER,
			},
			"x-error-codes": ["INVALID_BODY", "NOT_FOUND", "UPSTREAM_ERROR", "NO_DEEZER"],
		},
	},

	// ─── Daily Mix ───
	"/api/v1/mixes/daily": {
		get: {
			tags: ["Listens"],
			operationId: "getDailyMix",
			summary: "The user's Daily Mix of the day (home)",
			description:
				"Three of the user's top artists (listens + follows), a different three each day: about a third loved tracks by them (liked, recently played), the rest discoveries from their Deezer radios and ListenBrainz / Last.fm tracks similar to two loved ones, early skips left out, at most 3 per artist. With no history: the user's own Deezer Flow (never the service account's). Built on the first call of the day and cached until the day changes or `refresh=1`; yesterday's mix is served when today's can't be built. `tracks` is empty when there is nothing to build it from. Play its tracks with `source: \"daily-mix\"`.",
			security: userAuth,
			parameters: [
				query("day", str({ format: "date" }), "The client's date (YYYY-MM-DD); the server's UTC date when missing"),
				query("refresh", str({ enum: ["1"] }), "Build a new mix"),
			],
			responses: { ...okRes("DailyMixEnvelope", ref("DailyMix")), ...E_400, 503: err("NoDeezer"), ...E_USER },
			"x-error-codes": ["INVALID_DAY", "NO_DEEZER"],
		},
	},

	// ─── Listening log ───
	"/api/v1/listens": {
		post: {
			tags: ["Listens"],
			operationId: "logListens",
			summary: "Append finished plays to the listening log (recommendation signals)",
			description:
				"One event per play, sent when it ends (a repeat or a closed app may report a play in parts). Events whose startedAt is more than 5 min ahead, more than 30 days old, or after their endedAt are dropped and counted in `dropped`.",
			security: userAuth,
			requestBody: body(obj({ events: arr(ref("ListenInput"), { minItems: 1, maxItems: 50 }) }, ["events"])),
			responses: {
				...okRes("ListensEnvelope", obj({ stored: int(), dropped: int() }, ["stored", "dropped"])),
				...E_400,
				...E_USER,
			},
			"x-error-codes": ["INVALID_BODY"],
		},
	},

	// ─── Lyrics ───
	"/api/v1/lyrics/{trackId}": {
		parameters: [pathParam("trackId", "Deezer track id")],
		get: {
			tags: ["Lyrics"],
			operationId: "getLyrics",
			summary: "Lyrics (LRCLIB exact → Deezer → LRCLIB fuzzy search)",
			description: "Send title/artist/album/duration of the playing track for the best match; otherwise they come from the library, recent plays or the Deezer track API. Synced lyrics are only returned when the matched recording's length is within 3 s. No lyrics → 200 with `source: null`. 400 MISSING_METADATA only when there is no metadata and no Deezer session.",
			security: userAuth,
			parameters: [
				query("title", str(), "Track title"),
				query("artist", str(), "Artist name"),
				query("album", str(), "Album title"),
				query("duration", int(), "Duration in seconds (aligns synced lyrics; strongly recommended)"),
			],
			responses: { ...okRes("LyricsEnvelope", ref("Lyrics")), ...E_400, ...E_USER },
			"x-error-codes": ["MISSING_METADATA"],
		},
	},

	// ─── Shares ───
	"/api/v1/shares": {
		get: {
			tags: ["Shares"],
			operationId: "listShares",
			summary: "My share links",
			security: userAuth,
			responses: { ...okRes("SharedTrackListEnvelope", arr(ref("SharedTrack"))), ...E_USER },
		},
		post: {
			tags: ["Shares"],
			operationId: "createShare",
			summary: "Create (or reuse) a public share link for a track",
			description: "Returns 200 with your live (unexpired) share if one already exists for this track, 201 otherwise; your expired links for the track are deleted. The public metadata (title, artist, album, cover, duration) comes from Deezer when your Deezer session knows the track; otherwise the sent values are used (`title` and `artist` then required, non-blank). Public page: `https://wavelet.titosy.dev/share/t/{shareId}`.",
			security: userAuth,
			requestBody: body(ref("CreateShareInput")),
			responses: {
				...okRes("SharedTrackEnvelope", ref("SharedTrack"), "Existing share reused"),
				...okRes("SharedTrackEnvelope", ref("SharedTrack"), "Share created", "201"),
				...E_400,
				...E_USER,
			},
			"x-error-codes": ["MISSING_TRACK_ID", "INVALID_EXPIRY", "MISSING_METADATA"],
		},
	},
	"/api/v1/shares/{shareId}": {
		parameters: [pathParam("shareId", "Public share id")],
		get: {
			tags: ["Shares"],
			operationId: "getShare",
			summary: "Public share metadata (no auth)",
			security: noAuth,
			responses: { ...okRes("PublicShareEnvelope", ref("PublicShare")), ...E_404, 410: err("Gone"), 500: err("InternalError") },
			"x-error-codes": ["NOT_FOUND", "EXPIRED"],
		},
		delete: {
			tags: ["Shares"],
			operationId: "deleteShare",
			summary: "Revoke a share link (owner only)",
			security: userAuth,
			responses: { ...okRes("DeletedEnvelope", obj({ deleted: bool({ enum: [true] }) }, ["deleted"])), 403: err("Forbidden"), ...E_404, ...E_USER },
		},
	},
	"/api/v1/shares/{shareId}/stream": {
		parameters: [pathParam("shareId", "Public share id")],
		get: {
			tags: ["Shares", "Streaming"],
			operationId: "streamShare",
			summary: "Public audio stream of a shared track (no auth)",
			description: [
				"- **Cached copy** (the best R2 copy of the track, found by trackId — a copy persisted after the share was created is used and re-linked): proxied from R2, Range passed through (206 + `Content-Range`), `Accept-Ranges: bytes`, `Cache-Control: private, no-cache` (a revoked or expired link stops playing at once).",
				"- **Fallback** (no cached copy, or the R2 read failed): streamed live through the share owner's Deezer account with the same Range rules as `/stream-progressive` — no Range, `bytes=0-` or `bytes=0-b` → persisting play (200, or 206 `Content-Range: bytes 0-b/n` when the Deezer CDN honours ranges; `Accept-Ranges: none` when it does not); a single range starting above 0 → 206 live-only; past the end → 416 `Content-Range: bytes */n`. Limited to 30 fallback requests per client address per 10 min (per server instance): over it → 429 `RATE_LIMITED` + `Retry-After`. Errors before the first byte: 422 `TRACK_UNAVAILABLE` / 502 `UPSTREAM_ERROR`.",
				"- **Play counter**: +1 per successful (status < 400) request with no Range, `bytes=0-` or `bytes=0-n` with n > 1 (Safari / AVPlayer after their `bytes=0-1` probe) — not per seek, nor for a refused or failed request.",
			].join("\n"),
			security: noAuth,
			parameters: [{ name: "Range", in: "header", required: false, schema: str({ example: "bytes=0-" }) }],
			responses: {
				200: {
					description: "Full audio body",
					content: audioBinary,
					headers: {
						"Accept-Ranges": { schema: str({ enum: ["bytes", "none"] }) },
						"Content-Length": { description: "Absent on the fallback when the decoded size is unknown", schema: int() },
					},
				},
				206: {
					description: "Partial content (cached file, or fallback range)",
					content: audioBinary,
					headers: { "Content-Range": { schema: str() }, "Content-Length": { schema: int() } },
				},
				...E_404,
				410: err("Gone"),
				416: err("RangeNotSatisfiable"),
				422: err("TrackUnavailable"),
				429: err("ShareRateLimited"),
				500: err("InternalError"),
				502: err("DeezerUpstreamError"),
			},
			"x-error-codes": [
				"NOT_FOUND", "EXPIRED", "SHARE_OWNER_OFFLINE", "RATE_LIMITED", "TRACK_UNAVAILABLE", "UPSTREAM_ERROR",
				"STORAGE_UNAVAILABLE", "INTERNAL_ERROR",
			],
		},
	},

	// ─── Streaming ───
	"/api/v1/stream-url/{trackId}": {
		parameters: [pathParam("trackId", "Deezer track id")],
		get: {
			tags: ["Streaming"],
			operationId: "getStreamUrl",
			summary: "Step 1 — presigned direct URL if the track is cached",
			description:
				"Recommended playback flow:\n1. `GET /stream-url/{id}` → if `url` is set, play it directly (CDN, Range-capable, valid 1 h — refresh before `expiresAt`).\n2. Otherwise play `GET /stream-progressive/{id}` (live from Deezer, persisted to R2 in the background); with `status: presigned_disabled`, play `/stream/{id}`.\n`/stream/{id}` is the same-origin proxy for cached files.\nThe copy is chosen by the shared rank rules for this user's licence: a copy below the quality this user may get counts as `not_cached`, so the progressive play upgrades it.",
			security: userAuth,
			responses: { ...okRes("StreamUrlEnvelope", ref("StreamUrl")), ...E_USER },
		},
	},
	"/api/v1/stream/{trackId}": {
		parameters: [pathParam("trackId", "Deezer track id")],
		get: {
			tags: ["Streaming"],
			operationId: "streamCached",
			summary: "Stream a cached track (Range supported)",
			description: [
				"Same-origin proxy for the cached copy chosen by the shared rank rules for this user's licence; the Range header is passed through to R2 (206 + `Content-Range`).",
				"- No usable copy, or the object is gone from R2 (its rows are dropped) → 302 to `/api/v1/stream-progressive/{trackId}`.",
				"- A copy exists but below the quality this user may get (upgrade), the only copies are above this instance's quality setting, or storage is unreachable / refusing reads → 302 to `/api/v1/stream-progressive/{trackId}?live=1`.",
				"- `prefetch=1`: every non-hit (miss, upgrade, copies only in older storage, missing object, storage unavailable) → 404 `NOT_CACHED`, never a redirect to a live Deezer stream.",
				"The audio player must follow redirects and keep sending the session (cookie or bearer). A Range past the end of the cached file is not answered with 416: R2's refusal surfaces as a 500.",
			].join("\n"),
			security: userAuth,
			parameters: [
				query("prefetch", str({ enum: ["1"] }), "Only serve bytes that are already cached: every non-hit is a 404 NOT_CACHED instead of a 302"),
				{ name: "Range", in: "header", required: false, schema: str({ example: "bytes=0-" }) },
			],
			responses: {
				200: {
					description: "Full audio body",
					content: audioBinary,
					headers: { "Accept-Ranges": { schema: str({ enum: ["bytes"] }) }, "Content-Length": { schema: int() } },
				},
				206: {
					description: "Partial content",
					content: audioBinary,
					headers: { "Content-Range": { schema: str() }, "Content-Length": { schema: int() } },
				},
				302: {
					description: "Not served from cache → redirect to `/api/v1/stream-progressive/{trackId}` (or `…?live=1`, see description)",
					headers: { Location: { schema: str() } },
				},
				404: err("NotCached"),
				...E_USER,
			},
			"x-error-codes": ["NOT_AUTHENTICATED", "NOT_CACHED"],
		},
	},
	"/api/v1/stream-progressive/{trackId}": {
		parameters: [pathParam("trackId", "Deezer track id")],
		get: {
			tags: ["Streaming"],
			operationId: "streamProgressive",
			summary: "Live stream from Deezer (decrypted on the fly, persisted in background)",
			description: [
				"- **Already cached** (a usable copy for this listener's quality, object checked with a HEAD) → 302 to `/api/v1/stream/{trackId}`. Skipped with `live=1`.",
				"- **No Range, `bytes=0-` or `bytes=0-b`** (Safari / AVPlayer): a normal, persisting play. 200 with `Content-Length` when the decoded size is known, `Accept-Ranges: bytes` when the Deezer CDN honours ranges (else `none`); with a `bytes=0-…` Range and ranges honoured, 206 with `Content-Range: bytes 0-b/n` (body capped to that window, the persist continues).",
				"- **A single range starting above 0** (`bytes=a-` / `bytes=a-b`): 206 live-only (never persisted, no lock) with `Content-Range`, `Content-Length`, `Accept-Ranges: bytes`. Past the end → 416 with `Content-Range: bytes */n`. A CDN that refuses ranges → normal 200 play of the whole track. Multi-range, suffix (`bytes=-n`) and malformed headers are ignored (normal play).",
				"- A play never waits for another persist of the same track: on the same instance it streams the in-progress copy; while another instance persists it, it streams live, unpersisted.",
				"- `probe=1`: JSON `{ ok: true, cached }` when the track is streamable for this user; never opens the audio, never persists, takes no lock. Failures → 422 `TRACK_UNAVAILABLE` / 502 `UPSTREAM_ERROR` (plus the usual 401 / 403).",
				"- `preview=1`: live, never persisted, no lock; no `Content-Length`, `Accept-Ranges: none`, Range ignored. `head=1` caps it at ~3 s of audio at the server's `maxBitrate` (64 KiB floor, 512 KiB ceiling: 64 KiB MP3 128, 120 000 B MP3 320, 360 000 B FLAC).",
				"Errors before the first audio byte: 422 `TRACK_UNAVAILABLE` or 502 `UPSTREAM_ERROR`; anything else is a 500.",
			].join("\n"),
			security: userAuth,
			parameters: [
				query("probe", str({ enum: ["1"] }), "Check only: JSON `{ ok, cached }`, no audio, no persistence, no lock"),
				query("preview", str({ enum: ["1"] }), "Prefetch mode: live, no persistence, no download lock, Range ignored"),
				query("head", str({ enum: ["1"] }), "With preview=1: cap the response at ~3 s of audio at the server quality (64 KiB – 512 KiB)"),
				query(
					"live",
					str({ enum: ["1"] }),
					"Skip the cache check and stream from Deezer; the play still persists (sent by /stream when storage refuses reads, when the cached copy needs an upgrade, or when the only copies are above this instance's quality)"
				),
				{ name: "Range", in: "header", required: false, schema: str({ example: "bytes=0-" }) },
			],
			responses: {
				200: {
					description: "Audio body (`probe=1`: the JSON probe result)",
					content: { ...audioBinary, ...json(env("StreamProbeEnvelope", ref("StreamProbe"))) },
					headers: {
						"Accept-Ranges": { schema: str({ enum: ["bytes", "none"] }) },
						"Content-Length": { description: "Present on a full play when the decoded size is known; never with preview=1", schema: int() },
					},
				},
				206: {
					description: "Partial content: `bytes=0-b` on a persisting play, or a live-only range starting above 0",
					content: audioBinary,
					headers: {
						"Content-Range": { schema: str({ example: "bytes 1048576-2097151/9437184" }) },
						"Content-Length": { schema: int() },
						"Accept-Ranges": { schema: str({ enum: ["bytes"] }) },
					},
				},
				302: { description: "Already cached → redirect to /api/v1/stream/{trackId}", headers: { Location: { schema: str() } } },
				416: err("RangeNotSatisfiable"),
				422: err("TrackUnavailable"),
				502: err("DeezerUpstreamError"),
				...E_DEEZER,
			},
			"x-error-codes": [
				"NO_DEEZER_ARL", "DEEZER_LOGIN_FAILED", "TRACK_UNAVAILABLE", "UPSTREAM_ERROR", "APP_NOT_INITIALIZED", "STORAGE_UNAVAILABLE",
			],
		},
	},
	"/api/v1/stream-warm/{trackId}": {
		parameters: [pathParam("trackId", "Deezer track id")],
		get: {
			tags: ["Streaming"],
			operationId: "warmStream",
			summary: "Prefetch Deezer metadata so the next play starts faster",
			description: "Fire-and-forget, always 204 on success. Call when a track is about to be played (e.g. next in queue).",
			security: userAuth,
			responses: { 204: { description: "Accepted (no body)" }, ...E_DEEZER },
		},
	},

	// ─── Internal ───
	"/api/v1/internal/gc": {
		get: {
			tags: ["Internal"],
			operationId: "runStorageGc",
			summary: "Daily storage garbage collection (Vercel Cron — not for app clients)",
			description:
				"Run by the daily cron in `vercel.json`. Requires `Authorization: Bearer <CRON_SECRET>` (Vercel sends it to cron invocations when `CRON_SECRET` is set) → 401 `UNAUTHORIZED` otherwise. While `CRON_SECRET` is unset it is a no-op answering 200 `{ ran: false, reason }`, whatever the Authorization header. Deletes StoredTrack rows older than 24 h that nothing references and no persist is writing (with their object unless another row uses it), then objects under `tracks/` older than 24 h that no row points at. Bounded per run.",
			security: [{ cronSecret: [] }],
			responses: {
				...okRes("GcEnvelope", ref("GcResult")),
				401: {
					description: "`UNAUTHORIZED` — missing or wrong `Authorization: Bearer <CRON_SECRET>`",
					content: json(ref("ErrorResponse")),
				},
				500: {
					description: "`INTERNAL_ERROR` with the message \"Garbage collection failed.\"",
					content: json(ref("ErrorResponse")),
				},
			},
			"x-error-codes": ["UNAUTHORIZED", "INTERNAL_ERROR"],
		},
	},
};

// ── Shared error responses ──
const errorRes = (description) => ({ description, content: json(ref("ErrorResponse")) });
const responses = {
	BadRequest: errorRes("Invalid input"),
	NotAuthenticated: errorRes("`NOT_AUTHENTICATED` — no / expired session cookie"),
	NotAuthenticatedOrDeezerLoginFailed: errorRes("`NOT_AUTHENTICATED`, `DEEZER_LOGIN_FAILED` or `LOGIN_FAILED`"),
	NoDeezerArl: errorRes("`NO_DEEZER_ARL` — user has no Deezer account connected (send them to login-arl)"),
	Forbidden: errorRes("Forbidden"),
	NotFound: errorRes("`NOT_FOUND`"),
	Gone: errorRes("`EXPIRED` or `SHARE_OWNER_OFFLINE`"),
	RateLimited: errorRes("Upstream rate limit"),
	UpstreamError: errorRes("Upstream (Spotify) error"),
	ServiceUnavailable: errorRes("Service not configured"),
	NoDeezer: errorRes("`NO_DEEZER` — no user nor service Deezer session available"),
	InternalError: errorRes(
		"`INTERNAL_ERROR` (always the generic message \"An unexpected error occurred.\" — the detail is only logged server-side), `AUTH_ERROR`, `DEEZER_ERROR`, `APP_NOT_INITIALIZED` or (streaming) `STORAGE_UNAVAILABLE`"
	),
	NotCached: errorRes("`NOT_CACHED` — `prefetch=1` and the track has no usable cached copy"),
	TrackUnavailable: errorRes("`TRACK_UNAVAILABLE` — Deezer will not stream this track (licence, region, removed)"),
	DeezerUpstreamError: errorRes("`UPSTREAM_ERROR` — Deezer did not deliver or answer; retry"),
	RangeNotSatisfiable: {
		description: "Range starts past the end of the track (no body)",
		headers: {
			"Content-Range": { description: "`bytes */<size>` (`bytes */*` when the size is unknown)", schema: str() },
		},
	},
	ShareRateLimited: {
		...errorRes("`RATE_LIMITED` — too many Deezer fallback requests from this client address (30 per 10 min, per server instance)"),
		headers: { "Retry-After": { description: "Seconds until the window resets", schema: int() } },
	},
};

const spec = {
	openapi: "3.0.3",
	info: {
		title: "Wavelet API",
		version: "1.0.0",
		description: [
			"Music streaming / library API behind wavelet (Next.js on Vercel).",
			"",
			"## Response envelope",
			"Every `/api/v1/*` JSON route returns `{ \"success\": true, \"data\": … }` or `{ \"success\": false, \"error\": { \"code\", \"message\" } }`.",
			"Branch on `error.code`, not on the message. `/api/auth/*` (better-auth) does NOT use this envelope.",
			"A 500 `INTERNAL_ERROR` always carries the generic message \"An unexpected error occurred.\" (details are only logged server-side).",
			"",
			"## Authentication",
			"better-auth session (Google only), accepted two ways:",
			"- **Bearer (native / Flutter)**: sign in with `POST /api/auth/sign-in/social` + Google `idToken`, read the `set-auth-token` response header, then send `Authorization: Bearer <token>` on every request — including the audio player's requests. Sessions last 30 days.",
			"- **Cookie (web)**: `__Secure-better-auth.session_token` (plus `__Secure-better-auth.session_data`, a 5-min signed cache).",
			"Many routes also need a connected Deezer account (`NO_DEEZER_ARL` → call `/api/v1/auth/login-arl`).",
			"",
			"## Ids",
			"`trackId`, `deezerAlbumId`, `deezerArtistId` are Deezer ids (as strings). `albumId` in `/library/albums/{albumId}` and playlist ids are internal cuids.",
		].join("\n"),
	},
	servers: [
		{ url: "https://wavelet.titosy.dev", description: "Production" },
		{ url: "http://localhost:3000", description: "Local dev (`npm run dev`)" },
	],
	tags: [
		{ name: "Auth (session)", description: "better-auth endpoints (not enveloped)" },
		{ name: "Deezer account", description: "Connect / switch the Deezer account used for streaming" },
		{ name: "Browse", description: "Raw Deezer content — works as guest" },
		{ name: "Search", description: "Works as guest" },
		{ name: "Library", description: "Liked tracks, saved albums, followed artists" },
		{ name: "Playlists", description: "User playlists + Spotify import" },
		{ name: "Recent plays", description: "Listening history (drives server-side file cache lifecycle)" },
		{ name: "Listens", description: "Append-only listening log: one event per play, the recommendation signals" },
		{ name: "Lyrics", description: "Synced (LRC) and plain lyrics" },
		{ name: "Shares", description: "Public track share links" },
		{ name: "Streaming", description: "Audio playback endpoints" },
		{ name: "Settings", description: "Engine settings and UI preferences" },
		{ name: "Internal", description: "Server maintenance (Vercel Cron) — not for app clients" },
	],
	security: userAuth,
	paths,
	components: {
		securitySchemes: {
			bearerAuth: {
				type: "http",
				scheme: "bearer",
				description: "Session token from the `set-auth-token` header returned by `/api/auth/sign-in/social`.",
			},
			sessionCookie: {
				type: "apiKey",
				in: "cookie",
				name: "__Secure-better-auth.session_token",
				description: "better-auth session cookie (`better-auth.session_token` on http://localhost).",
			},
			cronSecret: {
				type: "http",
				scheme: "bearer",
				description: "`CRON_SECRET` env var, sent by Vercel Cron as `Authorization: Bearer <CRON_SECRET>` (internal routes only).",
			},
		},
		responses,
		schemas: { ...schemas, ...envelopes },
	},
};

writeFileSync(process.argv[2] ?? "openapi.json", JSON.stringify(spec, null, "\t") + "\n");
console.log(`paths: ${Object.keys(paths).length}, ops: ${Object.values(paths).reduce((n, p) => n + Object.keys(p).filter((k) => k !== "parameters").length, 0)}, schemas: ${Object.keys(spec.components.schemas).length}`);
