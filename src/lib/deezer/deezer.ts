import { API } from "./api";
import { DeezerError, WrongGeolocation, WrongLicense } from "./errors";
import { GW } from "./gw";
import got from "got";
import { Cookie, CookieJar } from "tough-cookie";
import type { User } from "./types";
import { errorSummary } from "@/lib/log-safe";
import {
	DEEZER_REQUEST_OPTIONS,
	DEEZER_USER_AGENT,
	isTransientNetworkError,
	toDeezerNetworkError,
} from "./http";

/** media.deezer.com/v1/get_url answer. */
interface MediaError {
	code?: number;
	message?: string;
}
interface GetUrlEntry {
	errors?: MediaError[];
	media?: { sources?: { url?: string }[] }[];
}
interface GetUrlResponse {
	data?: GetUrlEntry[];
	errors?: MediaError[];
}

/**
 * media.deezer.com's top-level "License token has no sufficient rights on
 * requested media." (HTTP 403): the account's licence does not cover the
 * format, whatever its can_stream_* flags said (verified live, free account
 * asking for MP3_320 / FLAC).
 */
const MEDIA_NO_RIGHTS = 1002;

/** The `errors` array of a get_url answer, from a parsed body or an HTTPError's raw body. */
function mediaErrorsOf(body: unknown): MediaError[] {
	let parsed: unknown = body;
	if (typeof body === "string" || Buffer.isBuffer(body)) {
		try {
			parsed = JSON.parse(body.toString());
		} catch {
			return [];
		}
	}
	const errors = (parsed as { errors?: unknown } | null)?.errors;
	return Array.isArray(errors) ? (errors as MediaError[]) : [];
}

export class Deezer {
	loggedIn: boolean;
	httpHeaders: { "User-Agent": string };
	cookieJar: CookieJar;
	currentUser?: User;
	childs: User[];
	selectedAccount: number;
	api: API;
	gw: GW;

	constructor() {
		this.httpHeaders = {
			"User-Agent": DEEZER_USER_AGENT,
		};
		this.cookieJar = new CookieJar();

		this.loggedIn = false;
		this.currentUser = {};
		this.childs = [];
		this.selectedAccount = 0;

		this.api = new API(this.cookieJar, this.httpHeaders);
		this.gw = new GW(this.cookieJar, this.httpHeaders);
	}

	async login(
		email: string,
		password: string,
		reCaptchaToken: string,
		child: string | number = 0
	) {
		if (child && typeof child === "string") child = parseInt(child);

		// Check if user already logged in
		let userData = await this.gw.get_user_data();
		if (!userData || (userData && Object.keys(userData).length === 0)) {
			return (this.loggedIn = false);
		}

		if (userData.USER.USER_ID === 0) return (this.loggedIn = false);

		const login = await got
			.post("https://www.deezer.com/ajax/action.php", {
				headers: this.httpHeaders,
				cookieJar: this.cookieJar,
				...DEEZER_REQUEST_OPTIONS,
				form: {
					type: "login",
					mail: email,
					password,
					checkFormLogin: userData.checkFormLogin,
					reCaptchaToken,
				},
			})
			.text();

		// Check if user logged in
		if (login.indexOf("success") === -1) {
			this.loggedIn = false;
			return false;
		}
		userData = await this.gw.get_user_data();
		await this._postLogin(userData);
		this.changeAccount(child);
		this.loggedIn = true;
		return true;
	}

	async loginViaArl(arl: string, child: string | number = 0) {
		if (child && typeof child === "string") child = parseInt(child);

		// Create cookie
		const cookie_obj = new Cookie({
			key: "arl",
			value: arl.trim(),
			domain: ".deezer.com",
			path: "/",
			httpOnly: true,
			secure: true,
		});
		await this.cookieJar.setCookie(
			cookie_obj.toString(),
			"https://www.deezer.com"
		);

		const userData = await this.gw.get_user_data();
		// Check if user logged in
		if (!userData || (userData && Object.keys(userData).length === 0))
			return (this.loggedIn = false);
		if (userData.USER.USER_ID === 0) return (this.loggedIn = false);

		await this._postLogin(userData);
		this.changeAccount(child);
		this.loggedIn = true;
		return true;
	}

	async _postLogin(userData) {
		this.childs = [];
		const family =
			userData.USER.MULTI_ACCOUNT.ENABLED &&
			!userData.USER.MULTI_ACCOUNT.IS_SUB_ACCOUNT;
		if (family) {
			const childs = await this.gw.get_child_accounts();
			childs.forEach((child) => {
				if (child.EXTRA_FAMILY.IS_LOGGABLE_AS) {
					this.childs.push({
						id: child.USER_ID,
						name: child.BLOG_NAME,
						picture: child.USER_PICTURE || "",
						license_token: userData.USER.OPTIONS.license_token,
						can_stream_hq:
							userData.USER.OPTIONS.web_hq || userData.USER.OPTIONS.mobile_hq,
						can_stream_lossless:
							userData.USER.OPTIONS.web_lossless ||
							userData.USER.OPTIONS.mobile_lossless,
						country: userData.USER.OPTIONS.license_country,
						language: userData.USER.SETTING.global.language || "",
						loved_tracks: child.LOVEDTRACKS_ID,
					});
				}
			});
		} else {
			this.childs.push({
				id: userData.USER.USER_ID,
				name: userData.USER.BLOG_NAME,
				picture: userData.USER.USER_PICTURE || "",
				license_token: userData.USER.OPTIONS.license_token,
				can_stream_hq:
					userData.USER.OPTIONS.web_hq || userData.USER.OPTIONS.mobile_hq,
				can_stream_lossless:
					userData.USER.OPTIONS.web_lossless ||
					userData.USER.OPTIONS.mobile_lossless,
				country: userData.USER.OPTIONS.license_country,
				language: userData.USER.SETTING.global.language || "",
				loved_tracks: userData.USER.LOVEDTRACKS_ID,
			});
		}
	}

	changeAccount(child_n): [User, number] {
		if (this.childs.length - 1 < child_n) child_n = 0;
		this.currentUser = this.childs[child_n];
		this.selectedAccount = child_n;
		let lang = this.currentUser?.language
			?.toString()
			.replace(/[^0-9A-Za-z *,-.;=]/g, "");
		if (lang?.slice(2, 1) === "-") {
			lang = lang.slice(0, 5);
		} else {
			lang = lang?.slice(0, 2);
		}
		this.httpHeaders["Accept-Language"] = lang;

		return [this.currentUser, this.selectedAccount];
	}

	async get_track_url(track_token, format): Promise<string | null> {
		const tracks = await this.get_tracks_url([track_token], format);
		if (tracks.length > 0) {
			if (tracks[0] instanceof DeezerError) throw tracks[0];
			else return tracks[0];
		}
		return null;
	}

	/**
	 * One entry per token, in order: the CDN URL, `null` when Deezer has no
	 * media for that format, or a DeezerError for that entry (WrongGeolocation
	 * for code 2002). Throws WrongLicense when the licence does not cover the
	 * format (top-level code 1002, HTTP 403), a DeezerNetworkError on a
	 * transient failure (it says nothing about availability; no retry here,
	 * the caller decides) and a plain DeezerError on any other error answer.
	 */
	async get_tracks_url(track_tokens, format): Promise<(string | DeezerError | null)[]> {
		if (!Array.isArray(track_tokens)) track_tokens = [track_tokens];
		if (!this.currentUser?.license_token) return [];
		if (
			((format === "FLAC" || format.startsWith("MP4_RA")) &&
				!this.currentUser.can_stream_lossless) ||
			(format === "MP3_320" && !this.currentUser.can_stream_hq)
		)
			throw new WrongLicense(format);

		let response: GetUrlResponse;
		try {
			response = await got
				.post("https://media.deezer.com/v1/get_url", {
					headers: this.httpHeaders,
					cookieJar: this.cookieJar,
					json: {
						license_token: this.currentUser.license_token,
						media: [
							{
								type: "FULL",
								formats: [{ cipher: "BF_CBC_STRIPE", format }],
							},
						],
						track_tokens,
					},
					...DEEZER_REQUEST_OPTIONS,
				})
				.json<GetUrlResponse>();
		} catch (e) {
			if (isTransientNetworkError(e)) throw toDeezerNetworkError(`get_url ${format}`, e);
			if (mediaErrorsOf(e?.response?.body).some((err) => err?.code === MEDIA_NO_RIGHTS)) {
				throw new WrongLicense(format);
			}
			throw new DeezerError(`get_url ${format}:: ${errorSummary(e)}`);
		}

		const data = Array.isArray(response?.data) ? response.data : undefined;
		if (!data) {
			const errors = mediaErrorsOf(response);
			if (errors.some((err) => err?.code === MEDIA_NO_RIGHTS)) throw new WrongLicense(format);
			if (errors.length) {
				throw new DeezerError(`get_url ${format}:: ${JSON.stringify(errors)}`);
			}
			return track_tokens.map(() => null);
		}

		return data.map((entry): string | DeezerError | null => {
			const entryError = Array.isArray(entry?.errors) ? entry.errors[0] : undefined;
			if (entryError) {
				// 2002: the track token has no rights here (region lock). 2000 / 2001
				// (undecodable / expired token) say nothing about the format.
				if (entryError.code === 2002) return new WrongGeolocation(this.currentUser?.country);
				return new DeezerError(`get_url ${format}:: ${JSON.stringify(entry.errors)}`);
			}
			return entry?.media?.[0]?.sources?.[0]?.url ?? null;
		});
	}
}
