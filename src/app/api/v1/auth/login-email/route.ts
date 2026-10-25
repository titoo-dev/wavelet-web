import { NextRequest } from "next/server";
import { setUserDz } from "@/lib/server-state";
import { saveDeezerCredential } from "@/lib/deezer-session";
import { deezerAccountPayload } from "@/lib/deezer/public-user";
import { ok, fail, handleError, requireUser, readJsonBody } from "../../_lib/helpers";

export async function POST(request: NextRequest) {
	try {
		const userResult = await requireUser(request);
		if (userResult.error) return userResult.error;

		const parsed = await readJsonBody<{ email?: string; password?: string }>(request);
		if (parsed.error) return parsed.error;
		const { email, password } = parsed.body;

		if (!email || !password) {
			return fail("MISSING_CREDENTIALS", "Email and password are required.", 400);
		}

		const { Deezer } = await import("@/lib/deezer");
		const dz = new Deezer();
		const loggedIn = await dz.login(email, password, "");

		if (!loggedIn) {
			return fail("LOGIN_FAILED", "Invalid email or password.", 401);
		}

		setUserDz(userResult.userId, dz);

		// Try to extract ARL from the Deezer cookie jar for persistence
		const arl = dz.cookieJar?.getCookiesSync?.("https://www.deezer.com")
			?.find((c) => c.key === "arl")?.value;

		if (arl) {
			await saveDeezerCredential(userResult.userId, arl, dz);
		}

		// Never hand the license token to the client (it requests media as this account)
		return ok(deezerAccountPayload(dz));
	} catch (e) {
		return handleError(e);
	}
}
