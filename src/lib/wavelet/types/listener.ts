export interface Listener {
	send: (key: string, data?: unknown) => void;
}
