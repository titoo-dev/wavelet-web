export interface ConfigStore {
	get<T = unknown>(key: string, userId?: string): Promise<T | null>;
	set(key: string, value: unknown, userId?: string): Promise<void>;
	init(): Promise<void>;
}
