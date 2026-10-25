import { NextRequest } from "next/server";
import { getWaveletApp, setUserDz } from "@/lib/server-state";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { restoreUserDz } from "@/lib/deezer-session";
import { encryptSecret } from "@/lib/secret-box";
import { toPublicDeezerUser } from "@/lib/deezer/public-user";
import { ok, handleError } from "../../_lib/helpers";

export async function GET(request: NextRequest) {
	try {
		const waveletApp = await getWaveletApp();

		const deezerAvailable = waveletApp
			? await waveletApp.isDeezerAvailable()
			: "no-network";

		const settings = waveletApp ? waveletApp.getSettings() : {};

		// Check better-auth session
		let betterAuthUser = null;
		let deezerUser = null;
		let deezerLoggedIn = false;

		try {
			const session = await auth.api.getSession({
				headers: request.headers,
			});

			if (session?.user) {
				betterAuthUser = {
					id: session.user.id,
					name: session.user.name,
					email: session.user.email,
					image: session.user.image,
				};

				// Restore the Deezer session from the stored ARL (shared single-flight
				// restore: decrypts the ARL, uses the saved child account), else
				// fall back to the service ARL for users without a credential.
				let dz = null;
				const restored = await restoreUserDz(session.user.id);
				if (restored.status === "ok") {
					dz = restored.dz;
				} else if (restored.status === "no-arl" && process.env.WAVELET_SERVICE_ARL) {
					const arl = process.env.WAVELET_SERVICE_ARL;
					const { Deezer } = await import("@/lib/deezer");
					dz = new Deezer();
					const loggedIn = await dz.loginViaArl(arl);
					if (loggedIn) {
						setUserDz(session.user.id, dz);
						// Persist service ARL as user credential if not already stored
						try {
							await prisma.deezerCredential.create({
								data: {
									userId: session.user.id,
									arl: encryptSecret(arl),
									// TODO: deezerUserId is a BigInt column; this string is what the
									// route has always sent (typed now that `prisma` is). Kept as is
									// in the lint clean-up: see the PR notes.
									deezerUserId: String(dz.currentUser?.id || "") as unknown as bigint,
									deezerUserName: dz.currentUser?.name || "",
									deezerPicture: dz.currentUser?.picture || "",
									canStreamHq: !!dz.currentUser?.can_stream_hq,
									canStreamLossless: !!dz.currentUser?.can_stream_lossless,
								},
							});
						} catch {
							// Ignore duplicate or write errors
						}
					} else {
						dz = null;
					}
				}

				if (dz?.loggedIn) {
					// Never hand the license token to the client (it requests media as this account)
					deezerUser = toPublicDeezerUser(dz.currentUser);
					deezerLoggedIn = true;
				}
			}
		} catch {
			// No session or auth error — continue as guest
		}

		return ok({
			// Better-auth status
			authenticated: !!betterAuthUser,
			user: betterAuthUser,
			// Deezer status
			deezerLoggedIn,
			deezerUser,
			// App status
			deezerAvailable,
			settings,
		});
	} catch (e) {
		return handleError(e);
	}
}
