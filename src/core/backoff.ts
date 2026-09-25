import type { BackoffFn, BackoffOptions } from "./types.ts";

/** Default base delay in ms for exponential backoff. */
export const DEFAULT_BASE_DELAY_MS = 200;
/** Default max delay cap in ms for exponential backoff. */
export const DEFAULT_MAX_DELAY_MS = 30_000;
/** Default jitter setting for exponential backoff. */
export const DEFAULT_JITTER = true;

export function buildBackoffFn(config?: BackoffFn | BackoffOptions): BackoffFn {
	if (typeof config === "function") {
		return config;
	}

	const baseDelayMs = config?.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
	const maxDelayMs = config?.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
	const jitter = config?.jitter ?? DEFAULT_JITTER;

	return (attempt: number): number => {
		const exponential = baseDelayMs * 2 ** attempt;
		const capped = Math.min(exponential, maxDelayMs);
		if (!jitter) return capped;
		// Full jitter: random value in [0, capped]
		return Math.random() * capped;
	};
}
