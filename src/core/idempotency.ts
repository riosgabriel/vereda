import { isIdempotentMethod } from "../queue/policy.ts";
import { ConfigurationError } from "./errors.ts";
import { uuidV4 } from "./nanoid.ts";
import type { RequestOptions, RetryConfig } from "./types.ts";

const HEADER = "Idempotency-Key";

/**
 * Returns `options` with an `Idempotency-Key` header added when the merged
 * `retry.idempotencyKey` is on, the method is not idempotent by definition and
 * the caller did not set a non-empty header themselves. Never mutates the
 * caller's options or headers. Only ever throws `ConfigurationError`: a
 * generator that throws or returns a blank or non-string value, a key that is
 * not a valid header value, or caller headers that cannot form a `Headers`.
 */
export function withIdempotencyKey(
	options: RequestOptions<unknown>,
	retryConfig: RetryConfig,
): RequestOptions<unknown> {
	const setting = retryConfig.idempotencyKey;
	if (!setting) return options;
	if (isIdempotentMethod(options.method ?? "GET")) return options;
	let headers: Headers;
	try {
		headers = new Headers(options.headers);
	} catch (err) {
		throw new ConfigurationError("request headers are not valid", { cause: err });
	}
	const existing = headers.get(HEADER);
	if (existing !== null && existing.trim() !== "") return options;
	let key: string;
	if (typeof setting === "function") {
		let raw: unknown;
		try {
			raw = setting();
		} catch (err) {
			throw new ConfigurationError("retry.idempotencyKey generator threw", { cause: err });
		}
		if (typeof raw !== "string" || raw.trim() === "") {
			throw new ConfigurationError("retry.idempotencyKey generator must return a non-empty string");
		}
		key = raw;
	} else {
		key = uuidV4();
	}
	try {
		headers.set(HEADER, key);
	} catch (err) {
		throw new ConfigurationError("retry.idempotencyKey is not a valid header value", { cause: err });
	}
	return { ...options, headers };
}
