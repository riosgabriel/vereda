import { ConfigurationError } from "./errors.js";
import type { ClientConfig, PartitionConfig, RequestOptions, RetryConfig, TimeoutConfig } from "./types.js";

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
	if (config.concurrency !== undefined) {
		if (!Number.isInteger(config.concurrency) || config.concurrency < 1) {
			throw new ConfigurationError("concurrency must be a positive integer");
		}
	}

	if (!config.timeout || config.timeout.attemptMs === undefined) {
		throw new ConfigurationError(
			"timeout.attemptMs is required — pass a positive number, or Infinity to explicitly opt out of a per-attempt timeout",
		);
	}
	validateTimeoutConfig(config.timeout, "timeout");
	validateRetryConfig(config.retry, "retry");
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

	if (timeout.attemptMs !== undefined && timeout.attemptMs <= 0) {
		throw new ConfigurationError(`${prefix}.attemptMs must be positive`);
	}

	if (timeout.totalMs !== undefined && timeout.totalMs <= 0) {
		throw new ConfigurationError(`${prefix}.totalMs must be positive`);
	}
}

function validateRetryConfig(retry: RetryConfig | undefined, prefix: string): void {
	if (!retry) return;

	if (retry.maxRetries !== undefined && retry.maxRetries < 0) {
		throw new ConfigurationError(`${prefix}.maxRetries must be non-negative`);
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
		if (baseDelayMs !== undefined && baseDelayMs < 0) {
			throw new ConfigurationError(`${prefix}.backoff.baseDelayMs must be non-negative`);
		}
		if (maxDelayMs !== undefined && maxDelayMs < 0) {
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
		if (config.concurrency !== undefined) {
			if (!Number.isInteger(config.concurrency) || config.concurrency < 1) {
				throw new ConfigurationError(`partitions.${name}.concurrency must be a positive integer`);
			}
		}
		if (config.maxQueueSize !== undefined && config.maxQueueSize < 1) {
			throw new ConfigurationError(`partitions.${name}.maxQueueSize must be at least 1`);
		}
		validateRetryConfig(config.retry, `partitions.${name}.retry`);
		validateTimeoutConfig(config.timeout, `partitions.${name}.timeout`);
	}
}
