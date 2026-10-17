import { describe, expect, it } from "vitest";
import { ConfigurationError } from "../../src/core/errors.ts";
import type { ClientConfig, RedirectMode } from "../../src/core/types.ts";
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

	// #203: setTimeout fires after ~1 ms for any delay it can't hold.
	it("accepts timeout values up to 2^31 - 1 ms", () => {
		const max = 2_147_483_647;
		expect(() => validateConfig({ timeout: { attemptMs: max, totalMs: max } })).not.toThrow();
	});

	it("rejects finite timeout attemptMs/totalMs above 2^31 - 1 ms", () => {
		const tooLong = 2_147_483_648;
		expect(() => validateConfig({ timeout: { attemptMs: tooLong } })).toThrow(/timeout\.attemptMs must not exceed/);
		expect(() => validateConfig({ timeout: { attemptMs: 5_000, totalMs: tooLong } })).toThrow(
			/timeout\.totalMs must not exceed/,
		);
		expect(() =>
			validateConfig({ timeout: { attemptMs: 5_000 }, partitions: { x: { timeout: { attemptMs: 3e9 } } } }),
		).toThrow(/partitions\.x\.timeout\.attemptMs must not exceed/);
		expect(() => validateRequestOptions({ timeout: { totalMs: 3e9 } })).toThrow(/request\.timeout\.totalMs/);
	});

	it("still accepts timeout totalMs: Infinity", () => {
		expect(() => validateConfig({ timeout: { attemptMs: 5_000, totalMs: Infinity } })).not.toThrow();
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

	it("accepts the supported redirect modes", () => {
		for (const redirect of ["follow", "manual"] as const) {
			expect(() => validateConfig({ timeout: { attemptMs: 5_000 }, redirect })).not.toThrow();
		}
	});

	it('rejects an unknown redirect mode, and fetch\'s "error" mode', () => {
		for (const redirect of ["manaul", "error"]) {
			expect(() => validateConfig({ timeout: { attemptMs: 5_000 }, redirect: redirect as RedirectMode })).toThrow(
				/redirect must be "follow" or "manual"/,
			);
		}
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

	it("rejects forbidden HTTP methods (TRACE, CONNECT, TRACK)", () => {
		expect(() => validateRequestOptions({ method: "TRACE" })).toThrow(ConfigurationError);
		expect(() => validateRequestOptions({ method: "trace" })).toThrow(
			/HTTP method 'TRACE' is forbidden by the Fetch specification/,
		);
		expect(() => validateRequestOptions({ method: "CONNECT" })).toThrow(ConfigurationError);
		expect(() => validateRequestOptions({ method: "TRACK" })).toThrow(ConfigurationError);
	});

	it("accepts standard HTTP methods", () => {
		expect(() => validateRequestOptions({ method: "GET" })).not.toThrow();
		expect(() => validateRequestOptions({ method: "POST" })).not.toThrow();
		expect(() => validateRequestOptions({ method: "PUT" })).not.toThrow();
		expect(() => validateRequestOptions({ method: "DELETE" })).not.toThrow();
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

describe("validateConfig retryBudget", () => {
	const base = { timeout: { attemptMs: 1_000 } } satisfies ClientConfig;
	const ok = { ratio: 0.1, windowMs: 10_000 };
	const cases: Array<[string, NonNullable<ClientConfig["retryBudget"]>, RegExp]> = [
		["ratio: -0.1", { ...ok, ratio: -0.1 }, /retryBudget\.ratio must be a non-negative finite number/],
		["ratio: NaN", { ...ok, ratio: Number.NaN }, /retryBudget\.ratio/],
		["windowMs: 0", { ...ok, windowMs: 0 }, /retryBudget\.windowMs must be a positive finite number/],
		["windowMs: Infinity", { ...ok, windowMs: Infinity }, /retryBudget\.windowMs/],
		["minRetriesPerSec: -1", { ...ok, minRetriesPerSec: -1 }, /retryBudget\.minRetriesPerSec/],
	];

	it.each(cases)("client-level %s", (_label, retryBudget, message) => {
		expect(() => validateConfig({ ...base, retryBudget })).toThrow(message);
	});

	it("validates partition-level retryBudget with the partition in the key", () => {
		expect(() => validateConfig({ ...base, partitions: { api: { retryBudget: { ...ok, windowMs: 0 } } } })).toThrow(
			/partitions\.api\.retryBudget\.windowMs/,
		);
	});

	it("accepts ratio 0 and minRetriesPerSec 0", () => {
		expect(() =>
			validateConfig({ ...base, retryBudget: { ratio: 0, windowMs: 1, minRetriesPerSec: 0 } }),
		).not.toThrow();
	});
});

describe("validateConfig rateLimit", () => {
	const base = { timeout: { attemptMs: 1_000 } } satisfies ClientConfig;
	const cases: Array<[string, NonNullable<ClientConfig["rateLimit"]>, RegExp]> = [
		["tokensPerSec: 0", { tokensPerSec: 0 }, /rateLimit\.tokensPerSec must be a positive finite number/],
		["tokensPerSec: Infinity", { tokensPerSec: Infinity }, /rateLimit\.tokensPerSec/],
		["burst: 0.5", { tokensPerSec: 1, burst: 0.5 }, /rateLimit\.burst must be a finite number of at least 1/],
		["burst: NaN", { tokensPerSec: 1, burst: Number.NaN }, /rateLimit\.burst/],
		["maxWaitMs: -1", { tokensPerSec: 1, maxWaitMs: -1 }, /rateLimit\.maxWaitMs must be non-negative/],
	];

	it.each(cases)("client-level %s", (_label, rateLimit, message) => {
		expect(() => validateConfig({ ...base, rateLimit })).toThrow(message);
	});

	it("validates partition-level rateLimit with the partition in the key", () => {
		expect(() => validateConfig({ ...base, defaultPartition: { rateLimit: { tokensPerSec: -1 } } })).toThrow(
			/defaultPartition\.rateLimit\.tokensPerSec/,
		);
	});

	it("accepts maxWaitMs 0 and Infinity", () => {
		expect(() => validateConfig({ ...base, rateLimit: { tokensPerSec: 1, maxWaitMs: 0 } })).not.toThrow();
		expect(() => validateConfig({ ...base, rateLimit: { tokensPerSec: 1, maxWaitMs: Infinity } })).not.toThrow();
	});
});

describe("validateConfig opting a partition out", () => {
	const base = { timeout: { attemptMs: 1_000 } } satisfies ClientConfig;

	it("accepts retryBudget: false and rateLimit: false on partitions and defaultPartition", () => {
		expect(() =>
			validateConfig({
				...base,
				retryBudget: { ratio: 0.1, windowMs: 10_000 },
				rateLimit: { tokensPerSec: 10 },
				partitions: { internal: { retryBudget: false, rateLimit: false } },
				defaultPartition: { retryBudget: false, rateLimit: false },
			}),
		).not.toThrow();
	});

	it.each([
		["retryBudget", { retryBudget: true }],
		["rateLimit", { rateLimit: "off" }],
	])("rejects a non-object %s other than false", (key, partition) => {
		expect(() => validateConfig({ ...base, partitions: { api: partition as never } })).toThrow(
			new RegExp(`partitions\\.api\\.${key} must be an object, or false to turn it off`),
		);
	});
});
