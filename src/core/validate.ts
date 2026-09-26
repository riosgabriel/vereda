import { ConfigurationError } from "./errors.ts";
import type {
	CircuitBreakerConfig,
	ClientConfig,
	PartitionConfig,
	RequestOptions,
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
	validatePartitions(config.partitions);
}

/** Validates a single request's own `timeout`/`retry` options — the raw
 *  values passed to `client.get()`/`.post()`/etc., before they're merged onto
 *  partition/client defaults. Reuses the same rules as `validateConfig`, so
 *  an invalid request-level value (e.g. `timeout: { attemptMs: -5 }`) is
 *  rejected the same way an invalid client config is, just surfaced as a
 *  ticket `ConfigurationError` instead of a throw from `create()`. Omitted
 *  fields stay valid (inherit the client/partition default), and `Infinity`
 *  stays a legal explicit `attemptMs`/`totalMs`. */
export function validateRequestOptions(options: Pick<RequestOptions, "timeout" | "retry">): void {
	validateTimeoutConfig(options.timeout, "request.timeout");
	validateRetryConfig(options.retry, "request.retry");
}

function validateTimeoutConfig(timeout: TimeoutConfig | undefined, prefix: string): void {
	if (!timeout) return;

	if (timeout.attemptMs !== undefined && !(timeout.attemptMs > 0)) {
		throw new ConfigurationError(`${prefix}.attemptMs must be positive`);
	}

	if (timeout.totalMs !== undefined && !(timeout.totalMs > 0)) {
		throw new ConfigurationError(`${prefix}.totalMs must be positive`);
	}
}

function validateRetryConfig(retry: RetryConfig | undefined, prefix: string): void {
	if (!retry) return;

	if (retry.maxRetries !== undefined && !(Number.isInteger(retry.maxRetries) && retry.maxRetries >= 0)) {
		throw new ConfigurationError(`${prefix}.maxRetries must be a non-negative integer`);
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
		if (config.concurrency !== undefined && !isPositiveInteger(config.concurrency)) {
			throw new ConfigurationError(`partitions.${name}.concurrency must be a positive integer`);
		}
		if (config.maxQueueSize !== undefined && !isPositiveInteger(config.maxQueueSize)) {
			throw new ConfigurationError(`partitions.${name}.maxQueueSize must be a positive integer`);
		}
		validateRetryConfig(config.retry, `partitions.${name}.retry`);
		validateTimeoutConfig(config.timeout, `partitions.${name}.timeout`);
		validateCircuitBreakerConfig(config.circuitBreaker, `partitions.${name}.circuitBreaker`);
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
