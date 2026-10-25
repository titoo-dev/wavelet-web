// Per-user Deezer sessions restored from the stored ARL — the single path
// used by requireDeezer, getGuestOrUserDz (helpers.ts), getOrLoginUserDz
// (server-state.ts) and auth/connect. One login per user at a time: N
// concurrent cold requests share one in-flight restore instead of logging in
// N times. The stored ARL is read through decryptSecret (enc:v1 or legacy
// plaintext) and a legacy plaintext value is re-encrypted after it logs in.

import { prisma } from "@/lib/prisma";
import { getUserDz, setUserDz } from "@/lib/server-state";
import { decryptSecret, encryptSecret, isEncryptedSecret } from "@/lib/secret-box";
import type { Deezer } from "@/lib/deezer";
import type { User } from "@/lib/deezer/types";

export type DzRestore =
	| { status: "ok"; dz: Deezer }
	| { status: "no-arl" }
	| { status: "login-failed" }
	| { status: "error"; error: unknown };

const globalForSessions = globalThis as unknown as {
	dzRestoreInflight?: Map<string, Promise<DzRestore>>;
};

function inflight(): Map<string, Promise<DzRestore>> {
	globalForSessions.dzRestoreInflight ??= new Map();
	return globalForSessions.dzRestoreInflight;
}

/**
 * The user's logged-in Deezer session: the cached one, else a login with the
 * stored ARL and child account (single-flight per user). Never throws.
 * - `no-arl`: no DeezerCredential row
 * - `login-failed`: Deezer refused the ARL, or the stored value can't be decrypted
 * - `error`: database / network failure
 */
export function restoreUserDz(userId: string): Promise<DzRestore> {
	const cached = getUserDz(userId);
	if (cached?.loggedIn) return Promise.resolve({ status: "ok", dz: cached });

	const pending = inflight().get(userId);
	if (pending) return pending;

	const restore: Promise<DzRestore> = loginFromStoredArl(userId).finally(() => {
		if (inflight().get(userId) === restore) inflight().delete(userId);
	});
	inflight().set(userId, restore);
	return restore;
}

async function loginFromStoredArl(userId: string): Promise<DzRestore> {
	try {
		const cred = await prisma.deezerCredential.findUnique({ where: { userId } });
		if (!cred) return { status: "no-arl" };

		const arl = decryptSecret(cred.arl);
		if (!arl) {
			console.warn(`[deezer-session] stored ARL of user ${userId} cannot be decrypted; treating it as invalid`);
			return { status: "login-failed" };
		}

		const { Deezer } = await import("@/lib/deezer");
		const dz = new Deezer();
		const loggedIn = await dz.loginViaArl(arl, cred.childAccount ?? 0);
		if (!loggedIn) return { status: "login-failed" };

		// A login-arl / login-email that landed while we were logging in wins.
		const current = getUserDz(userId);
		if (current?.loggedIn) return { status: "ok", dz: current };

		setUserDz(userId, dz);
		if (!isEncryptedSecret(cred.arl)) await reencryptLegacyArl(userId, cred.arl, arl);
		return { status: "ok", dz };
	} catch (error) {
		return { status: "error", error };
	}
}

/** Best effort: only rewrites the row if it still holds the same plaintext. */
async function reencryptLegacyArl(userId: string, storedValue: string, arl: string) {
	try {
		await prisma.deezerCredential.updateMany({
			where: { userId, arl: storedValue },
			data: { arl: encryptSecret(arl) },
		});
	} catch (e) {
		console.warn("[deezer-session] could not re-encrypt a legacy ARL:", e instanceof Error ? e.message : e);
	}
}

interface DzAccount {
	currentUser?: User;
	selectedAccount?: number;
}

function profileFields(dz: DzAccount) {
	return {
		childAccount: Number.isInteger(dz.selectedAccount) ? dz.selectedAccount : 0,
		deezerUserId: dz.currentUser?.id ?? null,
		deezerUserName: dz.currentUser?.name ?? null,
		deezerPicture: dz.currentUser?.picture ?? null,
		canStreamHq: dz.currentUser?.can_stream_hq ?? false,
		canStreamLossless: dz.currentUser?.can_stream_lossless ?? false,
	};
}

/** Persists a freshly logged-in ARL (encrypted) with the selected child account. */
export async function saveDeezerCredential(userId: string, arl: string, dz: DzAccount) {
	const data = { arl: encryptSecret(arl), ...profileFields(dz) };
	await prisma.deezerCredential.upsert({
		where: { userId },
		update: data,
		create: { userId, ...data },
	});
}

/** Records an account switch so the next cold restore logs into the same child. */
export async function saveSelectedAccount(userId: string, dz: DzAccount) {
	await prisma.deezerCredential.updateMany({ where: { userId }, data: profileFields(dz) });
}
