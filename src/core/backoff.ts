import type { BackoffFn, BackoffOptions } from "./types.js";

const DEFAULT_BASE_DELAY_MS = 200;
const DEFAULT_MAX_DELAY_MS = 30_000;

export function buildBackoffFn(config?: BackoffFn | BackoffOptions): BackoffFn {
  if (typeof config === "function") {
    return config;
  }

  const baseDelayMs = config?.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const maxDelayMs = config?.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const jitter = config?.jitter ?? true;

  return (attempt: number): number => {
    const exponential = baseDelayMs * 2 ** attempt;
    const capped = Math.min(exponential, maxDelayMs);
    if (!jitter) return capped;
    // Full jitter: random value in [0, capped]
    return Math.random() * capped;
  };
}
