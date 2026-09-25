import type { AppError } from "./errors.js";
import type { MetricsSink } from "./metrics.js";

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

export type Result<T> = { success: true; data: T; raw: Response } | { success: false; error: AppError };

// ---------------------------------------------------------------------------
// Parse function — schema-agnostic
// ---------------------------------------------------------------------------

export type ParseFn<T> = (data: unknown) => T;

// ---------------------------------------------------------------------------
// Backoff
// ---------------------------------------------------------------------------

export type BackoffFn = (attempt: number) => number;

export interface BackoffOptions {
	/** Base delay in ms. @default {@link DEFAULT_BASE_DELAY_MS} */
	baseDelayMs?: number;
	/** Maximum delay cap in ms. @default {@link DEFAULT_MAX_DELAY_MS} */
	maxDelayMs?: number;
	/** Whether to add jitter. @default {@link DEFAULT_JITTER} */
	jitter?: boolean;
}

// ---------------------------------------------------------------------------
// Timeout config
// ---------------------------------------------------------------------------

export interface TimeoutConfig {
	/** Per-attempt timeout in ms. Omit to inherit the client-level default;
	 *  `Infinity` explicitly means no per-attempt cap. Also bounds, from
	 *  attempt start, how long the caller has to read the body of a Response
	 *  handed back unread (a success without `parse`, or an `HttpError`'s
	 *  `.response`) before that read is aborted. */
	attemptMs?: number;
	/** Whole-ticket deadline in ms. Starts at request(); cancels the ticket
	 *  and resolves with DeadlineExceededError on expiry. Omit (or pass
	 *  `Infinity`) for no total deadline. Also caps how long the caller has
	 *  to read an unread Response's body handed back as above, if that's
	 *  sooner than `attemptMs` would otherwise allow. */
	totalMs?: number;
}

/** `ClientConfig.timeout` variant where `attemptMs` is mandatory. Every
 *  client must explicitly decide its per-attempt timeout — `Infinity` is a
 *  legal, deliberate choice to opt out of a cap. This is the one default in
 *  the library that cannot safely be implicit: every other default (retries,
 *  concurrency, queue sizes) fails safe when omitted; an omitted timeout
 *  fails unbounded. Partition- and request-level `timeout` stay optional —
 *  they inherit this client-level decision unless they override it. */
export interface ClientTimeoutConfig extends Omit<TimeoutConfig, "attemptMs"> {
	attemptMs: number;
}

/** True when `ms` is a real, finite bound — not omitted and not `Infinity`
 *  (the explicit "no cap" value). Use instead of `!== undefined` wherever a
 *  timeout/deadline value is checked, since `Infinity` must be treated the
 *  same as "not set" everywhere a timer would otherwise be created. */
export function isBoundedMs(ms: number | undefined): ms is number {
	return ms !== undefined && Number.isFinite(ms);
}

// ---------------------------------------------------------------------------
// Default retry-on-status codes (D1)
// ---------------------------------------------------------------------------

export const DEFAULT_RETRY_ON_STATUS: number[] = [408, 425, 429, 500, 502, 503, 504];

// ---------------------------------------------------------------------------
// Partition / bulkhead config
// ---------------------------------------------------------------------------

/** Default per-partition concurrency limit (decision D1). */
export const DEFAULT_CONCURRENCY = 5;
/** Default max queued items per partition before rejecting new ones. */
export const DEFAULT_MAX_QUEUE_SIZE = 100;

export interface PartitionConfig {
	/** Max concurrent in-flight retries for this partition.
	 *  @default {@link DEFAULT_CONCURRENCY} */
	concurrency?: number;
	/** Max number of pending items in the queue before rejecting new ones.
	 *  @default {@link DEFAULT_MAX_QUEUE_SIZE} */
	maxQueueSize?: number;
	/** When true, the first attempt also goes through the bulkhead (R6).
	 *  @default false */
	limitFirstAttempts?: boolean;
	retry?: RetryConfig;
	timeout?: TimeoutConfig;
	circuitBreaker?: CircuitBreakerConfig;
}

// ---------------------------------------------------------------------------
// Circuit breaker config
// ---------------------------------------------------------------------------

/** Default consecutive-failure count that trips the circuit open. */
export const DEFAULT_FAILURE_THRESHOLD = 5;
/** Default ms to stay open before allowing a half-open trial. */
export const DEFAULT_RESET_TIMEOUT_MS = 30_000;
/** Default number of concurrent trial requests allowed while half-open. */
export const DEFAULT_HALF_OPEN_MAX_ATTEMPTS = 1;

export interface CircuitBreakerConfig {
	/** @default false */
	enabled?: boolean;
	/** Consecutive-failure trip mode (default strategy).
	 *  @default {@link DEFAULT_FAILURE_THRESHOLD} */
	failureThreshold?: number;
	/** Rolling-window trip mode. If set, used INSTEAD of failureThreshold. */
	window?: {
		sizeMs: number;
		failureRatePercent: number;
		minimumRequests: number;
	};
	/** ms to stay open before allowing a half-open trial.
	 *  @default {@link DEFAULT_RESET_TIMEOUT_MS} */
	resetTimeoutMs?: number;
	/** concurrent trial requests allowed while half-open.
	 *  @default {@link DEFAULT_HALF_OPEN_MAX_ATTEMPTS} */
	halfOpenMaxAttempts?: number;
	/** Override default failure classification (network/timeout/retryable_status).
	 *  Not consulted for an error that shows the attempt never reached the host
	 *  (e.g. a body factory that threw before the request was dispatched) —
	 *  those are always ignored, since there is no host-health signal to classify. */
	isFailure?: (error: AppError) => boolean;
}

// ---------------------------------------------------------------------------
// Retry config
// ---------------------------------------------------------------------------

/** Default number of retries after the first attempt. */
export const DEFAULT_MAX_RETRIES = 3;

export interface RetryConfig {
	/** Retries after the first attempt. `MaxRetriesExceededError.attempts` is
	 *  total executions, i.e. `maxRetries + 1`.
	 *  @default {@link DEFAULT_MAX_RETRIES} */
	maxRetries?: number;
	/** @default `{ baseDelayMs: 200, maxDelayMs: 30_000, jitter: true }` */
	backoff?: BackoffFn | BackoffOptions;
	/** HTTP status codes that trigger retry (e.g. 408, 429, 500, 502, 503, 504).
	 *  @default {@link DEFAULT_RETRY_ON_STATUS} */
	retryOnStatus?: number[];
	/** Allows retrying non-idempotent methods (POST/PATCH/CONNECT). An
	 *  `Idempotency-Key` header also enables retries. Default: false. */
	idempotent?: boolean;
	/** Optional predicate to decide whether a failed attempt should be retried.
	 *  Called exactly once per failed attempt that could still be retried, with
	 *  the zero-based attempt number:
	 *  - 0 = the first attempt (called client-side before the retry loop)
	 *  - 1, 2, … = retries (called inside the loop, after attempt 0)
	 *  Returning `false` surfaces the error immediately without retrying. Not
	 *  called after the final attempt when no retries remain — there is
	 *  nothing left to decide. */
	retryWhen?: (error: AppError, attempt: number) => boolean;
}

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

export interface Logger {
	debug(msg: string, meta?: Record<string, unknown>): void;
	info(msg: string, meta?: Record<string, unknown>): void;
	warn(msg: string, meta?: Record<string, unknown>): void;
	error(msg: string, meta?: Record<string, unknown>): void;
}

// ---------------------------------------------------------------------------
// Lifecycle events
// ---------------------------------------------------------------------------

export type LifecycleEventMap = {
	request: { ticketId: string; url: string; method: string; partition: string };
	/** Zero-based retry index (0 = first retry after the initial attempt).
	 *  Note: retryWhen's attempt parameter uses a different numbering —
	 *  0 = first attempt, 1 = first retry, etc. */
	retry: {
		ticketId: string;
		url: string;
		attempt: number;
		delayMs: number;
		error: AppError;
	};
	success: {
		ticketId: string;
		url: string;
		attempts: number;
		durationMs: number;
		queuedMs: number;
		statusCode: number;
	};
	failure: {
		ticketId: string;
		url: string;
		attempts: number;
		durationMs: number;
		queuedMs: number;
		error: AppError;
	};
	cancelled: {
		ticketId: string;
		url: string;
		attempts: number;
		durationMs: number;
		queuedMs: number;
	};
	circuitOpen: { partition: string };
	circuitClose: { partition: string };
};

// ---------------------------------------------------------------------------
// Request options
// ---------------------------------------------------------------------------

export interface RequestOptions<T = unknown> {
	/** @default "GET" */
	method?: string;
	headers?: HeadersInit;
	/** Request body, or a factory that returns a fresh body on every attempt
	 *  (replayable body). A ReadableStream must be supplied via a factory. The
	 *  factory must return a fresh body each invocation — reusing the same
	 *  ReadableStream replays an already-consumed (empty) stream. */
	body?: BodyInit | (() => BodyInit);
	/** Named bulkhead partition. Defaults to `host` (hostname + port when non-default). */
	partition?: string;
	/** Schema parse function. Use withZod() or custom. */
	parse?: ParseFn<T>;
	retry?: RetryConfig;
	timeout?: TimeoutConfig;
	/** Signal to cancel the request externally */
	signal?: AbortSignal;
	/** Request URL - available for middleware to read/rewrite */
	url?: string;
}

// ---------------------------------------------------------------------------
// Client config
// ---------------------------------------------------------------------------

/** Default global concurrency cap across all partitions (decision D1). */
export const DEFAULT_GLOBAL_CONCURRENCY = 50;
/** Default max requests queued globally, across all partitions, waiting for
 *  a concurrency permit before new requests are rejected with QueueFullError. */
export const DEFAULT_GLOBAL_QUEUE_SIZE = 100;

export interface ClientConfig {
	/** Base URL prepended to all requests */
	baseUrl?: string;
	/** Default retry config */
	retry?: RetryConfig;
	/** Default timeout config. `attemptMs` is required — pass `Infinity` to
	 *  explicitly opt out of a per-attempt cap, so "no timeout" is always a
	 *  deliberate choice rather than an accidental default. */
	timeout: ClientTimeoutConfig;
	/** Global concurrency across all partitions.
	 *  @default {@link DEFAULT_GLOBAL_CONCURRENCY} */
	concurrency?: number;
	/** Max requests queued globally (across all partitions) waiting for a
	 *  concurrency permit before new requests are rejected with QueueFullError.
	 *  @default {@link DEFAULT_GLOBAL_QUEUE_SIZE} */
	maxQueueSize?: number;
	/** Per-partition overrides. Partitions not listed here use
	 *  `{ concurrency: 5, maxQueueSize: 100 }`.
	 *  @default {} */
	partitions?: Record<string, PartitionConfig>;
	/** Default circuit breaker config. Opt-in — inert unless `enabled: true`. */
	circuitBreaker?: CircuitBreakerConfig;
	/** Optional structured logger */
	logger?: Logger;
	/** Optional metrics sink for counters, histograms, and gauges. */
	metrics?: MetricsSink;
	/** Redact query parameter values in logged URLs.
	 *  @default true */
	redactQuery?: boolean;
	/** Custom fetch function (defaults to globalThis.fetch). */
	fetch?: typeof globalThis.fetch;
}

/** Options for `HttpClient.close()`.
 *
 *  Modelled as a union so the type mirrors the runtime contract: `timeoutMs` is
 *  required only when draining. A single `{ drain?: boolean; timeoutMs: number }`
 *  shape made `close({ drain: false })` a type error even though it is the
 *  documented, working way to close without draining. */
export type CloseOptions = { drain?: false; timeoutMs?: number } | { drain: true; timeoutMs: number };
