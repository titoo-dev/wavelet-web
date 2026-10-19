const DEVICE_KEY = "wavelet-device-id";
const CHANNEL = "wavelet-device";

function newId(): string {
	return typeof crypto !== "undefined" && "randomUUID" in crypto
		? crypto.randomUUID()
		: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function read(storage: Storage | undefined): string | null {
	try {
		return storage?.getItem(DEVICE_KEY) ?? null;
	} catch {
		return null;
	}
}

function save(storage: Storage | undefined, id: string) {
	try {
		storage?.setItem(DEVICE_KEY, id);
	} catch {
		// Private mode: the id lasts as long as the page.
	}
}

/**
 * This tab's Device id (CONTEXT.md, Device): kept in sessionStorage so a reload stays the same
 * Device. A duplicated tab copies sessionStorage, so tabs announce their id on a BroadcastChannel
 * and the newcomer takes a fresh one when another tab already holds it (was: a duplicated tab
 * took over its original's place in the picker). Resolves once other tabs had `waitMs` to object.
 */
export async function claimDeviceId(
	storage: Storage | undefined = typeof sessionStorage !== "undefined" ? sessionStorage : undefined,
	Channel: typeof BroadcastChannel | undefined = typeof BroadcastChannel !== "undefined" ? BroadcastChannel : undefined,
	waitMs = 150
): Promise<{ id: string; release: () => void }> {
	let id = read(storage) ?? newId();
	save(storage, id);
	const nonce = newId();
	if (!Channel) return { id, release: () => {} };
	let settled = false;

	const channel = new Channel(CHANNEL);
	channel.onmessage = (e: MessageEvent<{ type: string; id: string; nonce: string }>) => {
		const msg = e.data;
		if (!msg || msg.nonce === nonce) return;
		if (msg.type === "hello" && msg.id === id) channel.postMessage({ type: "taken", id, nonce });
		else if (msg.type === "taken" && msg.id === id && !settled) {
			id = newId();
			save(storage, id);
		}
	};
	channel.postMessage({ type: "hello", id, nonce });
	await new Promise((r) => setTimeout(r, waitMs));
	settled = true;
	// Keeps answering "taken" for later duplicates of this tab until released.
	return { id, release: () => channel.close() };
}

/** "Chrome · Windows": how this tab shows in the device picker. */
export function deviceName(ua: string = typeof navigator !== "undefined" ? navigator.userAgent : ""): string {
	const browser = /Edg\//.test(ua)
		? "Edge"
		: /OPR\//.test(ua)
			? "Opera"
			: /Firefox\//.test(ua)
				? "Firefox"
				: /Chrome\//.test(ua)
					? "Chrome"
					: /Safari\//.test(ua)
						? "Safari"
						: "Browser";
	const os = /Android/.test(ua)
		? "Android"
		: /iPhone|iPad|iPod/.test(ua)
			? "iOS"
			: /Windows/.test(ua)
				? "Windows"
				: /Mac OS X|Macintosh/.test(ua)
					? "macOS"
					: /CrOS/.test(ua)
						? "ChromeOS"
						: /Linux/.test(ua)
							? "Linux"
							: null;
	return os ? `${browser} · ${os}` : browser;
}

/**
 * Whether this tab may output sound: it has had a click, tap or key press (CONTEXT.md,
 * Activated Device). `navigator.userActivation` where the browser has it, else our own flag.
 */
export function watchActivation(onChange: () => void): { isActivated: () => boolean; dispose: () => void } {
	let gestured = false;
	const nav = typeof navigator !== "undefined" ? (navigator as Navigator & { userActivation?: { hasBeenActive: boolean } }) : undefined;
	const isActivated = () => gestured || !!nav?.userActivation?.hasBeenActive;
	const events = ["pointerup", "keydown", "touchend", "click"] as const;
	const onGesture = () => {
		if (gestured) return;
		gestured = true;
		events.forEach((e) => window.removeEventListener(e, onGesture, true));
		onChange();
	};
	if (typeof window === "undefined") return { isActivated, dispose: () => {} };
	events.forEach((e) => window.addEventListener(e, onGesture, true));
	return { isActivated, dispose: () => events.forEach((e) => window.removeEventListener(e, onGesture, true)) };
}
