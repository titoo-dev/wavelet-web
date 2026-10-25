export function convertDuration(duration: number): string {
	const mm = Math.floor(duration / 60);
	const ss = duration % 60;
	return `${mm}:${ss.toString().padStart(2, "0")}`;
}

export function isValidURL(text: string): boolean {
	const deezerRegex = /https?:\/\/(www\.)?deezer\.com\//;
	const spotifyRegex = /https?:\/\/open\.spotify\.com\//;
	const deezerPageLink = /https?:\/\/deezer\.page\.link\//;
	return deezerRegex.test(text) || spotifyRegex.test(text) || deezerPageLink.test(text);
}

export function debounce<A extends unknown[]>(
	func: (...args: A) => unknown,
	wait: number
): (...args: A) => void {
	let timeout: NodeJS.Timeout;
	return (...args: A) => {
		clearTimeout(timeout);
		timeout = setTimeout(() => func(...args), wait);
	};
}

export function copyToClipboard(text: string) {
	if (navigator.clipboard) {
		navigator.clipboard.writeText(text);
	}
}

export function formatSize(bytes: number): string {
	if (bytes === 0) return "0 B";
	const k = 1024;
	const sizes = ["B", "KB", "MB", "GB"];
	const i = Math.floor(Math.log(bytes) / Math.log(k));
	return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
}

export const qualities = [
	{ label: "MP3 128kbps", value: 1 },
	{ label: "MP3 320kbps", value: 3 },
	{ label: "FLAC", value: 9 },
];
