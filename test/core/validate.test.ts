import { describe, expect, it } from "vitest";
import { ConfigurationError } from "../../src/core/errors.ts";
import type { ClientConfig } from "../../src/core/types.ts";
import { validateConfig, validateRequestBody, validateRequestOptions } from "../../src/core/validate.ts";

describe("validateConfig", () => {
	it("accepts a minimal config with only timeout set", () => {
		expect(() => validateConfig({ timeout: { attemptMs: 5_000 } })).not.toThrow();
	});

	it("throws ConfigurationError when timeout is entirely missing", () => {
		expect(() => validateConfig({} as ClientConfig)).toThrow(ConfigurationError);
		expect(() => validateConfig({} as ClientConfig)).toThrow(/timeout\.attemptMs is required/);
	});

	it("throws ConfigurationError when timeout is present but attemptMs is omitted", () => {
		expect(() => validateConfig({ timeout: {} } as ClientConfig)).toThrow(ConfigurationError);
		expect(() => validateConfig({ timeout: {} } as ClientConfig)).toThrow(/timeout\.attemptMs is required/);
	});

	it("accepts timeout.attemptMs: Infinity as an explicit opt-out of a per-attempt timeout", () => {
		expect(() => validateConfig({ timeout: { attemptMs: Infinity } })).not.toThrow();
	});

	it("accepts valid full config", () => {
		expect(() =>
			validateConfig({
				concurrency: 10,
				timeout: { attemptMs: 1000 },
				retry: {
					maxRetries: 3,
					retryOnStatus: [429, 503],
					backoff: { baseDelayMs: 200, maxDelayMs: 30000 },
				},
				partitions: {
					api: { concurrency: 5, maxQueueSize: 50 },
				},
			}),
		).not.toThrow();
	});

	it("rejects negative concurrency", () => {
		expect(() => validateConfig({ timeout: { attemptMs: 5_000 }, concurrency: -1 })).toThrow(ConfigurationError);
	});

	it("rejects zero concurrency", () => {
		expect(() => validateConfig({ timeout: { attemptMs: 5_000 }, concurrency: 0 })).toThrow(ConfigurationError);
	});

	it("rejects non-integer concurrency", () => {
		expect(() => validateConfig({ timeout: { attemptMs: 5_000 }, concurrency: 1.5 })).toThrow(ConfigurationError);
	});

	it("rejects maxQueueSize < 1", () => {
		expect(() => validateConfig({ timeout: { attemptMs: 5_000 }, partitions: { x: { maxQueueSize: 0 } } })).toThrow(
			ConfigurationError,
		);
	});

	it("rejects negative maxRetries", () => {
		expect(() => validateConfig({ timeout: { attemptMs: 5_000 }, retry: { maxRetries: -1 } })).toThrow(
			ConfigurationError,
		);
	});

	it("rejects timeout attemptMs <= 0", () => {
		expect(() => validateConfig({ timeout: { attemptMs: 0 } })).toThrow(ConfigurationError);
	});

	it("rejects negative timeout attemptMs", () => {
		expect(() => validateConfig({ timeout: { attemptMs: -100 } })).toThrow(ConfigurationError);
	});

	it("rejects baseDelayMs > maxDelayMs", () => {
		expect(() =>
			validateConfig({
				timeout: { attemptMs: 5_000 },
				retry: { backoff: { baseDelayMs: 1000, maxDelayMs: 100 } },
			}),
		).toThrow(ConfigurationError);
	});

	it("rejects negative baseDelayMs", () => {
		expect(() => validateConfig({ timeout: { attemptMs: 5_000 }, retry: { backoff: { baseDelayMs: -1 } } })).toThrow(
			ConfigurationError,
		);
	});

	it("rejects negative maxDelayMs", () => {
		expect(() => validateConfig({ timeout: { attemptMs: 5_000 }, retry: { backoff: { maxDelayMs: -1 } } })).toThrow(
			ConfigurationError,
		);
	});

	it("rejects partition concurrency < 1", () => {
		expect(() => validateConfig({ timeout: { attemptMs: 5_000 }, partitions: { api: { concurrency: 0 } } })).toThrow(
			ConfigurationError,
		);
	});

	it("rejects partition maxRetries < 0", () => {
		expect(() =>
			validateConfig({ timeout: { attemptMs: 5_000 }, partitions: { api: { retry: { maxRetries: -1 } } } }),
		).toThrow(ConfigurationError);
	});

	it("accepts empty retryOnStatus", () => {
		expect(() => validateConfig({ timeout: { attemptMs: 5_000 }, retry: { retryOnStatus: [] } })).not.toThrow();
	});

	it("accepts valid retryOnStatus codes", () => {
		expect(() => validateConfig({ timeout: { attemptMs: 5_000 }, retry: { retryOnStatus: [429, 503] } })).not.toThrow();
	});

	it("rejects non-error status in retryOnStatus", () => {
		expect(() => validateConfig({ timeout: { attemptMs: 5_000 }, retry: { retryOnStatus: [200] } })).toThrow(
			ConfigurationError,
		);
	});

	it("rejects status above 599 in retryOnStatus", () => {
		expect(() => validateConfig({ timeout: { attemptMs: 5_000 }, retry: { retryOnStatus: [503, 600] } })).toThrow(
			ConfigurationError,
		);
	});

	it("rejects non-integer status in retryOnStatus", () => {
		expect(() => validateConfig({ timeout: { attemptMs: 5_000 }, retry: { retryOnStatus: [503.5] } })).toThrow(
			ConfigurationError,
		);
	});

	it("rejects a stream-like body via duck-typing", () => {
		expect(() => validateRequestBody({ getReader: () => ({}) } as unknown as BodyInit)).toThrow(ConfigurationError);
	});
});

describe("validateRequestOptions", () => {
	it("accepts empty options (both timeout and retry omitted)", () => {
		expect(() => validateRequestOptions({})).not.toThrow();
	});

	it("accepts timeout entirely omitted", () => {
		expect(() => validateRequestOptions({ retry: { maxRetries: 2 } })).not.toThrow();
	});

	it("rejects request timeout.attemptMs <= 0", () => {
		expect(() => validateRequestOptions({ timeout: { attemptMs: -5 } })).toThrow(ConfigurationError);
		expect(() => validateRequestOptions({ timeout: { attemptMs: -5 } })).toThrow(
			/request\.timeout\.attemptMs must be positive/,
		);
	});

	it("accepts request timeout.attemptMs: Infinity as an explicit opt-out", () => {
		expect(() => validateRequestOptions({ timeout: { attemptMs: Infinity } })).not.toThrow();
	});

	it("rejects request retry.maxRetries < 0", () => {
		expect(() => validateRequestOptions({ retry: { maxRetries: -1 } })).toThrow(ConfigurationError);
		expect(() => validateRequestOptions({ retry: { maxRetries: -1 } })).toThrow(
			/request\.retry\.maxRetries must be a non-negative integer/,
		);
	});

	it("rejects an invalid request retry.backoff field", () => {
		expect(() => validateRequestOptions({ retry: { backoff: { baseDelayMs: -1 } } })).toThrow(ConfigurationError);
		expect(() => validateRequestOptions({ retry: { backoff: { baseDelayMs: -1 } } })).toThrow(
			/request\.retry\.backoff\.baseDelayMs must be non-negative/,
		);
	});

	it("rejects invalid request retry.retryOnStatus codes", () => {
		expect(() => validateRequestOptions({ retry: { retryOnStatus: [200] } })).toThrow(
			/request\.retry\.retryOnStatus must contain only integer HTTP error status codes/,
		);
	});
});

describe("validateConfig rejects NaN and non-integers (B11)", () => {
	const base = { timeout: { attemptMs: 1_000 } } satisfies ClientConfig;
	const cases: Array<[string, Partial<ClientConfig>, RegExp]> = [
		["timeout.attemptMs: NaN", { timeout: { attemptMs: Number.NaN } }, /timeout\.attemptMs must be positive/],
		["timeout.totalMs: NaN", { timeout: { attemptMs: 1_000, totalMs: Number.NaN } }, /timeout\.totalMs/],
		["retry.maxRetries: NaN", { retry: { maxRetries: Number.NaN } }, /maxRetries must be a non-negative integer/],
		["retry.maxRetries: 1.5", { retry: { maxRetries: 1.5 } }, /maxRetries must be a non-negative integer/],
		["backoff.baseDelayMs: NaN", { retry: { backoff: { baseDelayMs: Number.NaN } } }, /baseDelayMs/],
		["maxQueueSize: -1", { maxQueueSize: -1 }, /^Invalid configuration: maxQueueSize/],
		["maxQueueSize: 2.5", { maxQueueSize: 2.5 }, /^Invalid configuration: maxQueueSize/],
		["partition maxQueueSize: NaN", { partitions: { a: { maxQueueSize: Number.NaN } } }, /partitions\.a\.maxQueueSize/],
		["baseUrl: relative", { baseUrl: "/api" }, /baseUrl must be an absolute URL/],
	];

	it.each(cases)("%s", (_label, patch, message) => {
		expect(() => validateConfig({ ...base, ...patch })).toThrow(message);
	});

	it("accepts a global maxQueueSize of 0 (overflow rejects immediately)", () => {
		expect(() => validateConfig({ ...base, maxQueueSize: 0 })).not.toThrow();
	});
});

describe("validateConfig circuitBreaker", () => {
	const base = { timeout: { attemptMs: 1_000 } } satisfies ClientConfig;
	const window = { sizeMs: 10_000, failureRatePercent: 50, minimumRequests: 10 };
	const cases: Array<[string, NonNullable<ClientConfig["circuitBreaker"]>, RegExp]> = [
		["failureThreshold: 0", { failureThreshold: 0 }, /failureThreshold must be a positive integer/],
		["failureThreshold: NaN", { failureThreshold: Number.NaN }, /failureThreshold/],
		["resetTimeoutMs: 0", { resetTimeoutMs: 0 }, /resetTimeoutMs must be a positive finite number/],
		["resetTimeoutMs: Infinity", { resetTimeoutMs: Infinity }, /resetTimeoutMs/],
		["halfOpenMaxAttempts: 0", { halfOpenMaxAttempts: 0 }, /halfOpenMaxAttempts must be a positive integer/],
		["isFailure: not a function", { isFailure: "yes" as never }, /isFailure must be a function/],
		["window.sizeMs: 0", { window: { ...window, sizeMs: 0 } }, /window\.sizeMs/],
		["window.failureRatePercent: 0", { window: { ...window, failureRatePercent: 0 } }, /failureRatePercent/],
		["window.failureRatePercent: 101", { window: { ...window, failureRatePercent: 101 } }, /failureRatePercent/],
		["window.minimumRequests: 0", { window: { ...window, minimumRequests: 0 } }, /minimumRequests/],
	];

	it.each(cases)("client-level %s", (_label, circuitBreaker, message) => {
		expect(() => validateConfig({ ...base, circuitBreaker })).toThrow(message);
	});

	it("validates partition-level circuitBreaker with the partition in the key", () => {
		expect(() =>
			validateConfig({ ...base, partitions: { api: { circuitBreaker: { halfOpenMaxAttempts: 0 } } } }),
		).toThrow(/partitions\.api\.circuitBreaker\.halfOpenMaxAttempts/);
	});

	it("accepts a complete valid config", () => {
		expect(() =>
			validateConfig({
				...base,
				circuitBreaker: { enabled: true, resetTimeoutMs: 5_000, halfOpenMaxAttempts: 2, window, isFailure: () => true },
			}),
		).not.toThrow();
	});
});
