import { isIdempotentMethod } from "../queue/policy.ts";
import { ConfigurationError } from "./errors.ts";
import type { RequestOptions, RetryConfig } from "./types.ts";

const HEADER = "Idempotency-Key";

/**
 * Returns `options` with an `Idempotency-Key` header added when the merged
 * `retry.idempotencyKey` is on, the method is not idempotent by definition and
 * the caller did not set the header themselves. Never mutates the caller's
 * options or headers. Throws `ConfigurationError` if a generator function
 * throws or returns an empty or non-string value.
 */
export function withIdempotencyKey(
	options: RequestOptions<unknown>,
	retryConfig: RetryConfig,
): RequestOptions<unknown> {
	const setting = retryConfig.idempotencyKey;
	if (!setting) return options;
	if (isIdempotentMethod(options.method ?? "GET")) return options;
	const headers = new Headers(options.headers);
	if (headers.has(HEADER)) return options;
	let key: unknown;
	if (typeof setting === "function") {
		try {
			key = setting();
		} catch (err) {
			throw new ConfigurationError("retry.idempotencyKey generator threw", { cause: err });
		}
		if (typeof key !== "string" || key === "") {
			throw new ConfigurationError("retry.idempotencyKey generator must return a non-empty string");
		}
	} else {
		key = crypto.randomUUID();
	}
	headers.set(HEADER, key as string);
	return { ...options, headers };
}
