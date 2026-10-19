import { getElementVolume, setElementVolume } from "@/utils/audio-context";

// Track one active fade timer per audio element to prevent concurrent fades fighting over volume
const activeTimers = new WeakMap<HTMLAudioElement, ReturnType<typeof setInterval>>();

/**
 * Fade an element's volume. Goes through setElementVolume: a GainNode once
 * the element is routed through Web Audio (element.volume is read-only on
 * iOS — was: fades and crossfades did nothing there), element.volume
 * otherwise.
 */
export function adjustVolume(
	audio: HTMLAudioElement,
	targetVolume: number,
	options: { duration?: number } = {}
): Promise<void> {
	// Cancel any in-progress fade on this element before starting a new one
	const existing = activeTimers.get(audio);
	if (existing !== undefined) clearInterval(existing);

	const { duration = 1000 } = options;
	const interval = 13;
	const steps = Math.ceil(duration / interval);
	const startVolume = getElementVolume(audio);
	const delta = targetVolume - startVolume;
	// Progress follows the clock, not the tick count: a hidden tab runs intervals about once a
	// second, and a fade counted in 13 ms steps then took ~40 s before the pause it led to.
	const startedAt = Date.now();

	return new Promise((resolve) => {
		if (steps === 0 || delta === 0) {
			setElementVolume(audio, targetVolume);
			activeTimers.delete(audio);
			resolve();
			return;
		}

		const timer = setInterval(() => {
			const progress = Math.min(1, (Date.now() - startedAt) / duration);
			// Ease in-out (cosine)
			const eased = 0.5 - Math.cos(progress * Math.PI) / 2;
			setElementVolume(audio, startVolume + delta * eased);

			if (progress >= 1) {
				clearInterval(timer);
				activeTimers.delete(audio);
				setElementVolume(audio, targetVolume);
				resolve();
			}
		}, interval);
		activeTimers.set(audio, timer);
	});
}
