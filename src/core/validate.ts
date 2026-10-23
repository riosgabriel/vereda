import { ConfigurationError } from "./errors.ts";
import { MAX_TIMER_MS } from "./timer.ts";
import type {
	CircuitBreakerConfig,
	ClientConfig,
	CloseOptions,
	PartitionConfig,
	PauseOnRetryAfterConfig,
	RateLimitConfig,
	RedirectMode,
	RequestOptions,
	ResponseType,
	RetryBudgetConfig,
	RetryConfig,
	TimeoutConfig,
} from "./types.ts";

// Every numeric check is written so that NaN fails it: `NaN <= 0` is false,
// so a bare `x <= 0` guard would let NaN through (and `attemptMs: NaN` would
// silently mean "no timeout"). `!(x > 0)` rejects it.

function isPositiveInteger(value: number): boolean {
	return Number.isInteger(value) && value >= 1;
}

/** Realm-safe ReadableStream detection — instanceof fails across realms
 *  (vm contexts, other copies of node:stream/web). No non-stream BodyInit
 *  member has getReader, so duck-typing is safe here. */
export function isReadableStream(body: unknown): body is ReadableStream {
	return body != null && typeof (body as { getReader?: unknown }).getReader === "function";
}

/** A raw ReadableStream body cannot be replayed across retries, so it must be
 *  supplied via a factory. Throws ConfigurationError otherwise. */
export function validateRequestBody(body: BodyInit | (() => BodyInit) | undefined): void {
	if (isReadableStream(body)) {
		throw new ConfigurationError("body must be supplied as a factory (() => BodyInit) when it is a ReadableStream");
	}
}

/** Validates `close()` options. A drain needs a finite `timeoutMs` in
 *  `(0, MAX_TIMER_MS]`: it is the only thing that bounds the wait, and the
 *  drain timer silently fires after ~1 ms for anything `setTimeout` can't hold. */
export function validateCloseOptions(opts: CloseOptions | undefined): void {
	if (!opts?.drain) return;
	const { timeoutMs } = opts as { timeoutMs?: unknown };
	if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
		throw new ConfigurationError("close({ drain: true }) requires a finite, positive timeoutMs");
	}
	if (timeoutMs > MAX_TIMER_MS) {
		throw new ConfigurationError(`close({ drain: true }) timeoutMs must not exceed ${MAX_TIMER_MS} ms`);
	}
}

const REDIRECT_MODES: ReadonlySet<unknown> = new Set<RedirectMode>(["follow", "manual"]);

export function validateConfig(config: ClientConfig): void {
	if (config.baseUrl !== undefined && !URL.canParse(config.baseUrl)) {
		throw new ConfigurationError("baseUrl must be an absolute URL");
	}

	if (config.concurrency !== undefined && !isPositiveInteger(config.concurrency)) {
		throw new ConfigurationError("concurrency must be a positive integer");
	}

	// 0 is valid globally: no waiting, overflow rejects with QueueFullError.
	if (config.maxQueueSize !== undefined && !(Number.isInteger(config.maxQueueSize) && config.maxQueueSize >= 0)) {
		throw new ConfigurationError("maxQueueSize must be a non-negative integer");
	}

	if (!config.timeout || config.timeout.attemptMs === undefined) {
		throw new ConfigurationError(
			"timeout.attemptMs is required — pass a positive number, or Infinity to explicitly opt out of a per-attempt timeout",
		);
	}
	validateTimeoutConfig(config.timeout, "timeout");
	validateRetryConfig(config.retry, "retry");
	validateCircuitBreakerConfig(config.circuitBreaker, "circuitBreaker");
	validateRetryBudgetConfig(config.retryBudget, "retryBudget");
	validateRateLimitConfig(config.rateLimit, "rateLimit");
	validatePauseOnRetryAfterConfig(config.pauseOnRetryAfter, "pauseOnRetryAfter");
	validatePartitions(config.partitions);
	validatePartitionConfig(config.defaultPartition, "defaultPartition");
	if (config.redirect !== undefined && !REDIRECT_MODES.has(config.redirect)) {
		throw new ConfigurationError(
			'redirect must be "follow" or "manual" (use "manual" to reject redirects: a 3xx comes back as an HttpError)',
		);
	}
}

const FORBIDDEN_METHODS = new Set(["TRACE", "CONNECT", "TRACK"]);

/** Validates a single request's method and `timeout`/`retry` options — the raw
 *  values passed to `client.get()`/`.post()`/etc., before they're merged onto
 *  partition/client defaults. Rejects forbidden HTTP methods (`TRACE`, `CONNECT`,
 *  `TRACK`), and reuses the same rules as `validateConfig`, so an invalid request-level
 *  value (e.g. `timeout: { attemptMs: -5 }`) is rejected the same way an invalid client
 *  config is, just surfaced as a ticket `ConfigurationError` instead of a throw from
 *  `create()`. Omitted fields stay valid (inherit the client/partition default), and
 *  `Infinity` stays a legal explicit `attemptMs`/`totalMs`. */
const RESPONSE_TYPES: ReadonlySet<string> = new Set<ResponseType>(["json", "text", "arrayBuffer", "blob", "none"]);

export function validateRequestOptions(
	options: Pick<RequestOptions, "timeout" | "retry" | "method" | "responseType">,
): void {
	if (options.method && FORBIDDEN_METHODS.has(options.method.toUpperCase())) {
		throw new ConfigurationError(
			`HTTP method '${options.method.toUpperCase()}' is forbidden by the Fetch specification`,
		);
	}
	if (options.responseType !== undefined && !RESPONSE_TYPES.has(options.responseType)) {
		throw new ConfigurationError(`request.responseType must be one of ${[...RESPONSE_TYPES].join(", ")}`);
	}
	validateTimeoutConfig(options.timeout, "request.timeout");
	validateRetryConfig(options.retry, "request.retry");
}

function validateTimeoutConfig(timeout: TimeoutConfig | undefined, prefix: string): void {
	if (!timeout) return;

	validateTimerMs(timeout.attemptMs, `${prefix}.attemptMs`);
	validateTimerMs(timeout.totalMs, `${prefix}.totalMs`);
}

/** A timeout that arms a timer directly must be positive, and if finite, fit
 *  in `setTimeout`: a larger value would fire after ~1 ms instead of later.
 *  `Infinity` stays legal, meaning "no timeout" (see isBoundedMs). */
function validateTimerMs(ms: number | undefined, name: string): void {
	if (ms === undefined) return;
	if (!(ms > 0)) {
		throw new ConfigurationError(`${name} must be positive`);
	}
	if (Number.isFinite(ms) && ms > MAX_TIMER_MS) {
		throw new ConfigurationError(`${name} must not exceed ${MAX_TIMER_MS} ms (use Infinity for no timeout)`);
	}
}

function validateRetryConfig(retry: RetryConfig | undefined, prefix: string): void {
	if (!retry) return;

	if (retry.maxRetries !== undefined && !(Number.isInteger(retry.maxRetries) && retry.maxRetries >= 0)) {
		throw new ConfigurationError(`${prefix}.maxRetries must be a non-negative integer`);
	}

	if (
		retry.idempotencyKey !== undefined &&
		typeof retry.idempotencyKey !== "boolean" &&
		typeof retry.idempotencyKey !== "function"
	) {
		throw new ConfigurationError(`${prefix}.idempotencyKey must be a boolean or a function`);
	}

	if (retry.retryOnStatus !== undefined) {
		for (const status of retry.retryOnStatus) {
			if (!Number.isInteger(status) || status < 400 || status > 599) {
				throw new ConfigurationError(
					`${prefix}.retryOnStatus must contain only integer HTTP error status codes (400-599)`,
				);
			}
		}
	}

	if (retry.backoff && typeof retry.backoff === "object") {
		const { baseDelayMs, maxDelayMs } = retry.backoff;
		if (baseDelayMs !== undefined && !(baseDelayMs >= 0)) {
			throw new ConfigurationError(`${prefix}.backoff.baseDelayMs must be non-negative`);
		}
		if (maxDelayMs !== undefined && !(maxDelayMs >= 0)) {
			throw new ConfigurationError(`${prefix}.backoff.maxDelayMs must be non-negative`);
		}
		if (baseDelayMs !== undefined && maxDelayMs !== undefined && baseDelayMs > maxDelayMs) {
			throw new ConfigurationError(`${prefix}.backoff.baseDelayMs must not exceed maxDelayMs`);
		}
	}
}

function validatePartitions(partitions: Record<string, PartitionConfig> | undefined): void {
	if (!partitions) return;
	for (const [name, config] of Object.entries(partitions)) {
		validatePartitionConfig(config, `partitions.${name}`);
	}
}

function validatePartitionConfig(config: PartitionConfig | undefined, prefix: string): void {
	if (!config) return;
	if (config.concurrency !== undefined && !isPositiveInteger(config.concurrency)) {
		throw new ConfigurationError(`${prefix}.concurrency must be a positive integer`);
	}
	if (config.maxQueueSize !== undefined && !isPositiveInteger(config.maxQueueSize)) {
		throw new ConfigurationError(`${prefix}.maxQueueSize must be a positive integer`);
	}
	validateRetryConfig(config.retry, `${prefix}.retry`);
	validateTimeoutConfig(config.timeout, `${prefix}.timeout`);
	validateCircuitBreakerConfig(config.circuitBreaker, `${prefix}.circuitBreaker`);
	validateRetryBudgetConfig(config.retryBudget, `${prefix}.retryBudget`);
	validateRateLimitConfig(config.rateLimit, `${prefix}.rateLimit`);
	validatePauseOnRetryAfterConfig(config.pauseOnRetryAfter, `${prefix}.pauseOnRetryAfter`);
}

function validatePauseOnRetryAfterConfig(pause: PauseOnRetryAfterConfig | false | undefined, prefix: string): void {
	if (pause === undefined || pause === false) return;
	if (typeof pause !== "object" || pause === null) {
		throw new ConfigurationError(`${prefix} must be an object, or false to turn it off`);
	}
	if (
		pause.statuses !== undefined &&
		!(Array.isArray(pause.statuses) && pause.statuses.every((s) => Number.isInteger(s) && s >= 100 && s <= 599))
	) {
		throw new ConfigurationError(`${prefix}.statuses must be an array of HTTP status codes (100-599)`);
	}
	if (pause.maxPauseMs !== undefined && !(Number.isFinite(pause.maxPauseMs) && pause.maxPauseMs > 0)) {
		throw new ConfigurationError(`${prefix}.maxPauseMs must be a positive finite number`);
	}
}

function validateRateLimitConfig(rateLimit: RateLimitConfig | false | undefined, prefix: string): void {
	if (rateLimit === undefined || rateLimit === false) return;
	if (typeof rateLimit !== "object" || rateLimit === null) {
		throw new ConfigurationError(`${prefix} must be an object, or false to turn it off`);
	}
	if (!(Number.isFinite(rateLimit.tokensPerSec) && rateLimit.tokensPerSec > 0)) {
		throw new ConfigurationError(`${prefix}.tokensPerSec must be a positive finite number`);
	}
	// Below 1, the bucket could never hold the whole token an attempt needs.
	if (rateLimit.burst !== undefined && !(Number.isFinite(rateLimit.burst) && rateLimit.burst >= 1)) {
		throw new ConfigurationError(`${prefix}.burst must be a finite number of at least 1`);
	}
	// 0 is legal (never wait); Infinity is the same as omitting it.
	if (rateLimit.maxWaitMs !== undefined && !(rateLimit.maxWaitMs >= 0)) {
		throw new ConfigurationError(`${prefix}.maxWaitMs must be non-negative`);
	}
}

function validateRetryBudgetConfig(budget: RetryBudgetConfig | false | undefined, prefix: string): void {
	if (budget === undefined || budget === false) return;
	if (typeof budget !== "object" || budget === null) {
		throw new ConfigurationError(`${prefix} must be an object, or false to turn it off`);
	}
	// 0 is legal: only the minRetriesPerSec floor is left.
	if (!(Number.isFinite(budget.ratio) && budget.ratio >= 0)) {
		throw new ConfigurationError(`${prefix}.ratio must be a non-negative finite number`);
	}
	if (!(Number.isFinite(budget.windowMs) && budget.windowMs > 0)) {
		throw new ConfigurationError(`${prefix}.windowMs must be a positive finite number`);
	}
	if (
		budget.minRetriesPerSec !== undefined &&
		!(Number.isFinite(budget.minRetriesPerSec) && budget.minRetriesPerSec >= 0)
	) {
		throw new ConfigurationError(`${prefix}.minRetriesPerSec must be a non-negative finite number`);
	}
}

function validateCircuitBreakerConfig(breaker: CircuitBreakerConfig | undefined, prefix: string): void {
	if (!breaker) return;

	if (breaker.failureThreshold !== undefined && !isPositiveInteger(breaker.failureThreshold)) {
		throw new ConfigurationError(`${prefix}.failureThreshold must be a positive integer`);
	}
	// Finite: the open -> half-open transition is a timer, and an unbounded
	// reset would keep the circuit open forever.
	if (
		breaker.resetTimeoutMs !== undefined &&
		!(Number.isFinite(breaker.resetTimeoutMs) && breaker.resetTimeoutMs > 0)
	) {
		throw new ConfigurationError(`${prefix}.resetTimeoutMs must be a positive finite number`);
	}
	// 0 would admit no half-open trial, so the circuit could never close again.
	if (breaker.halfOpenMaxAttempts !== undefined && !isPositiveInteger(breaker.halfOpenMaxAttempts)) {
		throw new ConfigurationError(`${prefix}.halfOpenMaxAttempts must be a positive integer`);
	}
	if (breaker.isFailure !== undefined && typeof breaker.isFailure !== "function") {
		throw new ConfigurationError(`${prefix}.isFailure must be a function`);
	}

	const { window } = breaker;
	if (window === undefined) return;
	if (!(Number.isFinite(window.sizeMs) && window.sizeMs > 0)) {
		throw new ConfigurationError(`${prefix}.window.sizeMs must be a positive finite number`);
	}
	if (!(window.failureRatePercent > 0 && window.failureRatePercent <= 100)) {
		throw new ConfigurationError(`${prefix}.window.failureRatePercent must be greater than 0 and at most 100`);
	}
	if (!isPositiveInteger(window.minimumRequests)) {
		throw new ConfigurationError(`${prefix}.window.minimumRequests must be a positive integer`);
	}
}
