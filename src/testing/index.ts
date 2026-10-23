import { ConfigurationError } from "../core/errors.ts";

/** One thing `faultyFetch` can do to a call. Exactly one shape per fault. */
export type Fault =
	/** Answer with this status without calling the inner `fetch`. */
	| { status: number; retryAfter?: number | string; body?: string; headers?: HeadersInit }
	/** Wait `latencyMs`, then call the inner `fetch` as usual. */
	| { latencyMs: number }
	/** Reject with a `TypeError`, like `fetch` does when the network fails. */
	| { networkError: true }
	/** Never settle, until the request's signal aborts. */
	| { hang: true };

export interface FaultyFetchOptions {
	/** Probability, 0 to 1, that a call gets a fault.
	 *  @default 1 */
	rate?: number;
	/** The faults to pick from, uniformly. Required and non-empty. */
	faults: readonly Fault[];
	/** Seed for a deterministic sequence: the same seed gives the same faults in the same order.
	 *  Omit it to draw from `Math.random`. */
	seed?: number;
	/** Only calls for which this returns `true` can get a fault; the others pass straight through
	 *  and don't consume a draw from the sequence. */
	match?: (request: Request) => boolean;
}

/** mulberry32: a small seeded generator returning floats in [0, 1). */
function mulberry32(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const FAULT_KEYS = ["status", "latencyMs", "networkError", "hang"] as const;
const BODYLESS_STATUSES = new Set([204, 205, 304]);

function validate(options: FaultyFetchOptions): void {
	const { rate, faults, seed } = options;
	if (rate !== undefined && !(typeof rate === "number" && rate >= 0 && rate <= 1)) {
		throw new ConfigurationError("faultyFetch.rate must be a number from 0 to 1");
	}
	if (seed !== undefined && !Number.isInteger(seed)) {
		throw new ConfigurationError("faultyFetch.seed must be an integer");
	}
	if (!Array.isArray(faults) || faults.length === 0) {
		throw new ConfigurationError("faultyFetch.faults must be a non-empty array");
	}
	faults.forEach((fault, i) => {
		const at = `faultyFetch.faults[${i}]`;
		const keys = FAULT_KEYS.filter((key) => fault !== null && typeof fault === "object" && key in fault);
		if (keys.length !== 1) {
			throw new ConfigurationError(`${at} must have exactly one of status, latencyMs, networkError or hang`);
		}
		const f = fault as Record<string, unknown>;
		switch (keys[0]) {
			case "status": {
				const status = f.status;
				// A Response can't carry a 1xx status, so 200 is the floor.
				if (!Number.isInteger(status) || (status as number) < 200 || (status as number) > 599) {
					throw new ConfigurationError(`${at}.status must be an integer from 200 to 599`);
				}
				if (BODYLESS_STATUSES.has(status as number) && f.body !== undefined) {
					throw new ConfigurationError(`${at}.body is not allowed with status ${status}`);
				}
				const ra = f.retryAfter;
				if (
					ra !== undefined &&
					!(typeof ra === "string" ? ra !== "" : typeof ra === "number" && Number.isFinite(ra) && ra >= 0)
				) {
					throw new ConfigurationError(`${at}.retryAfter must be a non-negative number or a non-empty string`);
				}
				break;
			}
			case "latencyMs":
				if (typeof f.latencyMs !== "number" || !Number.isFinite(f.latencyMs) || f.latencyMs < 0) {
					throw new ConfigurationError(`${at}.latencyMs must be a finite number >= 0`);
				}
				break;
			case "networkError":
				if (f.networkError !== true) throw new ConfigurationError(`${at}.networkError must be true`);
				break;
			case "hang":
				if (f.hang !== true) throw new ConfigurationError(`${at}.hang must be true`);
				break;
		}
	});
}

function signalOf(input: Parameters<typeof fetch>[0], init: RequestInit | undefined): AbortSignal | undefined {
	return init?.signal ?? (input instanceof Request ? input.signal : undefined) ?? undefined;
}

/** The request as `match` sees it. It never reads or transfers the body, so the real call still can. */
function toRequest(input: Parameters<typeof fetch>[0], init: RequestInit | undefined): Request {
	const url = input instanceof Request ? input.url : String(input);
	const base = input instanceof Request ? input : undefined;
	return new Request(url, {
		method: init?.method ?? base?.method,
		headers: init?.headers ?? base?.headers,
		signal: signalOf(input, init),
	});
}

function abortReason(signal: AbortSignal): unknown {
	return signal.reason ?? new DOMException("This operation was aborted", "AbortError");
}

/** Settles after `ms` (never, when `ms` is `undefined`), or rejects with the signal's reason as soon as it aborts. */
function wait(ms: number | undefined, signal: AbortSignal | undefined): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) return reject(abortReason(signal));
		let timer: ReturnType<typeof setTimeout> | undefined;
		const onAbort = () => {
			if (timer !== undefined) clearTimeout(timer);
			reject(abortReason(signal as AbortSignal));
		};
		if (ms !== undefined) {
			timer = setTimeout(() => {
				signal?.removeEventListener("abort", onAbort);
				resolve();
			}, ms);
		}
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

/**
 * Wraps a `fetch` so some calls fail on purpose, for tests of how a client copes.
 *
 * Each call that `match` accepts (all of them, by default) takes two draws from the
 * generator, in this order: first one that decides whether the call gets a fault
 * (`draw < rate`), then one that picks which of `faults`. Both are always taken, so the
 * pick sequence doesn't shift when `rate` changes. A call `match` rejects takes none.
 * With a `seed`, the sequence is the same every run.
 *
 * Waits (`latencyMs`, `hang`) use the global `setTimeout` at call time, so fake timers
 * work, and end with the signal's reason as soon as the request's signal aborts.
 *
 * @example
 * const client = HttpClient.create({
 *   fetch: faultyFetch(fetch, { faults: [{ status: 503, retryAfter: 1 }], seed: 42, rate: 0.5 }),
 * });
 *
 * @throws {ConfigurationError} when `options` is invalid.
 */
export function faultyFetch(inner: typeof fetch, options: FaultyFetchOptions): typeof fetch {
	validate(options);
	const { faults, match } = options;
	const rate = options.rate ?? 1;
	const random = options.seed === undefined ? Math.random : mulberry32(options.seed);

	return async (input, init) => {
		if (match && !match(toRequest(input, init))) return inner(input, init);
		const faulted = random() < rate;
		const fault = faults[Math.min(Math.floor(random() * faults.length), faults.length - 1)] as Fault;
		if (!faulted) return inner(input, init);

		const signal = signalOf(input, init);
		if ("status" in fault) {
			if (signal?.aborted) throw abortReason(signal);
			const headers = new Headers(fault.headers);
			if (fault.retryAfter !== undefined) headers.set("Retry-After", String(fault.retryAfter));
			return new Response(fault.body ?? null, { status: fault.status, headers });
		}
		if ("latencyMs" in fault) {
			await wait(fault.latencyMs, signal);
			return inner(input, init);
		}
		if ("networkError" in fault) throw new TypeError("fetch failed");
		await wait(undefined, signal);
		return inner(input, init);
	};
}
