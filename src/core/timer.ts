/** The largest delay `setTimeout` honours (2^31 - 1 ms, about 24.8 days).
 *  Anything larger, including `Infinity`, is clamped to 1 ms by Node. */
export const MAX_TIMER_MS = 2_147_483_647;

/** Like `setTimeout(callback, ms)`, but waits the full `ms` even past
 *  `MAX_TIMER_MS`, for delays vereda computes rather than the caller writes
 *  (backoff, a capped `Retry-After`, a token-bucket wait). Every timer it
 *  arms is `unref()`'d where the runtime supports it. Returns a function that
 *  cancels the wait; calling it after `callback` ran is a no-op. */
export function setLongTimeout(callback: () => void, ms: number): () => void {
	let remaining = ms;
	let timer: ReturnType<typeof setTimeout>;
	const arm = () => {
		const chunk = Math.min(remaining, MAX_TIMER_MS);
		remaining -= chunk;
		timer = setTimeout(remaining > 0 ? arm : callback, chunk);
		timer.unref?.();
	};
	arm();
	return () => clearTimeout(timer);
}
