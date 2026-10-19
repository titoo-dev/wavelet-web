import { afterEach, describe, expect, it, vi } from "vitest";
import { claimDeviceId, deviceName, watchActivation } from "./device";

function memoryStorage(): Storage {
	const m = new Map<string, string>();
	return {
		getItem: (k) => m.get(k) ?? null,
		setItem: (k, v) => void m.set(k, v),
		removeItem: (k) => void m.delete(k),
		clear: () => m.clear(),
		key: (i) => [...m.keys()][i] ?? null,
		get length() {
			return m.size;
		},
	};
}

/** BroadcastChannel between tabs of one test, delivering asynchronously like the real one. */
function fakeChannels() {
	const open = new Set<FakeChannel>();
	class FakeChannel {
		onmessage: ((e: MessageEvent) => void) | null = null;
		constructor(readonly name: string) {
			open.add(this);
		}
		postMessage(data: unknown) {
			for (const c of open) {
				if (c !== this && c.name === this.name) queueMicrotask(() => c.onmessage?.({ data } as MessageEvent));
			}
		}
		close() {
			open.delete(this);
		}
	}
	return FakeChannel as unknown as typeof BroadcastChannel;
}

describe("claimDeviceId", () => {
	it("keeps the id across reloads of the same tab", async () => {
		const storage = memoryStorage();
		const first = await claimDeviceId(storage, fakeChannels(), 0);
		first.release(); // the page goes away
		const again = await claimDeviceId(storage, fakeChannels(), 0);
		expect(again.id).toBe(first.id);
	});

	it("a duplicated tab gets an id of its own (was: it took over its original in the picker)", async () => {
		const Channel = fakeChannels();
		const original = memoryStorage();
		const a = await claimDeviceId(original, Channel, 5);
		// Duplicating a tab copies its sessionStorage.
		const copy = memoryStorage();
		copy.setItem("wavelet-device-id", a.id);
		const b = await claimDeviceId(copy, Channel, 5);
		expect(b.id).not.toBe(a.id);
		expect(copy.getItem("wavelet-device-id")).toBe(b.id);
		expect(original.getItem("wavelet-device-id")).toBe(a.id);
		a.release();
		b.release();
	});

	it("two tabs with different ids leave each other alone", async () => {
		const Channel = fakeChannels();
		const a = await claimDeviceId(memoryStorage(), Channel, 5);
		const s = memoryStorage();
		s.setItem("wavelet-device-id", "other");
		const b = await claimDeviceId(s, Channel, 5);
		expect(b.id).toBe("other");
		a.release();
		b.release();
	});

	it("works without storage (private mode)", async () => {
		const broken = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); } } as unknown as Storage;
		const { id } = await claimDeviceId(broken, undefined, 0);
		expect(id).toMatch(/.+/);
	});
});

describe("deviceName", () => {
	it.each([
		["Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36", "Chrome · Windows"],
		["Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/141.0 Safari/537.36 Edg/141.0", "Edge · Windows"],
		["Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15", "Safari · macOS"],
		["Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0", "Firefox · Linux"],
		["Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 Chrome/141.0 Mobile Safari/537.36", "Chrome · Android"],
		["Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile Safari/604.1", "Safari · iOS"],
		["Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 Chrome/141.0 Safari/537.36", "Chrome · ChromeOS"],
		["Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/141.0 Safari/537.36 OPR/110.0", "Opera · Windows"],
		["curl/8.0", "Browser"],
	])("%s → %s", (ua, name) => {
		expect(deviceName(ua)).toBe(name);
	});
});

describe("watchActivation", () => {
	afterEach(() => vi.restoreAllMocks());

	it("turns activated on the first click and says so once", () => {
		const onChange = vi.fn();
		const { isActivated, dispose } = watchActivation(onChange);
		expect(isActivated()).toBe(false);
		window.dispatchEvent(new Event("pointerup"));
		window.dispatchEvent(new Event("keydown"));
		expect(isActivated()).toBe(true);
		expect(onChange).toHaveBeenCalledTimes(1);
		dispose();
	});

	it("trusts navigator.userActivation where the browser has it", () => {
		Object.defineProperty(navigator, "userActivation", { value: { hasBeenActive: true }, configurable: true });
		const { isActivated, dispose } = watchActivation(() => {});
		expect(isActivated()).toBe(true);
		dispose();
		Reflect.deleteProperty(navigator, "userActivation");
	});
});
