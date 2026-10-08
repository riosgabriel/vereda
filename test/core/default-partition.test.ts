import * as http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HttpClient } from "../../src/core/client.ts";
import { CircuitOpenError, ConfigurationError, TimeoutError } from "../../src/core/errors.ts";
import { DEFAULT_CONCURRENCY, DEFAULT_MAX_QUEUE_SIZE, partitionLookup } from "../../src/core/types.ts";
import { validateConfig } from "../../src/core/validate.ts";

/** 503 by default; `/slow` never answers within the test's attemptMs. */
let server: http.Server;
let url: string;
let host: string;
let hits = 0;

beforeAll(async () => {
	server = http.createServer((req, res) => {
		hits++;
		if (req.url === "/slow") {
			setTimeout(() => res.end("late"), 1_000);
			return;
		}
		res.statusCode = 503;
		res.end("down");
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	const addr = server.address() as { port: number };
	url = `http://127.0.0.1:${addr.port}`;
	host = `127.0.0.1:${addr.port}`;
});

afterAll(async () => {
	server.closeAllConnections();
	await new Promise<void>((r) => server.close(() => r()));
});

const fastRetry = { maxRetries: 0, backoff: { baseDelayMs: 1, jitter: false } };

describe("defaultPartition", () => {
	it("applies retry and bulkhead limits to an unlisted host", async () => {
		const client = HttpClient.create({
			baseUrl: url,
			timeout: { attemptMs: 5_000 },
			retry: fastRetry,
			defaultPartition: { concurrency: 3, maxQueueSize: 7, retry: { maxRetries: 2 } },
		});
		hits = 0;
		await client.get("/").toPromise();

		expect(hits).toBe(3); // 1 attempt + defaultPartition.retry.maxRetries
		expect(client.partitions()).toEqual([{ name: host, running: 0, queued: 0, concurrency: 3, maxQueueSize: 7 }]);
	});

	it("applies its timeout to an unlisted host", async () => {
		const client = HttpClient.create({
			baseUrl: url,
			timeout: { attemptMs: 5_000 },
			retry: fastRetry,
			defaultPartition: { timeout: { attemptMs: 50 } },
		});
		const result = await client.get("/slow").toPromise();

		expect(!result.success && result.error).toBeInstanceOf(TimeoutError);
	});

	it("applies its circuit breaker to an unlisted host", async () => {
		const client = HttpClient.create({
			baseUrl: url,
			timeout: { attemptMs: 5_000 },
			retry: fastRetry,
			defaultPartition: { circuitBreaker: { enabled: true, failureThreshold: 1 } },
		});
		await client.get("/").toPromise();
		const rejected = await client.get("/").toPromise();

		expect(!rejected.success && rejected.error).toBeInstanceOf(CircuitOpenError);
	});

	it("is not inherited by a listed partition", async () => {
		const client = HttpClient.create({
			baseUrl: url,
			timeout: { attemptMs: 5_000 },
			retry: fastRetry,
			partitions: { [host]: {} },
			defaultPartition: { concurrency: 3, retry: { maxRetries: 2 } },
		});
		hits = 0;
		await client.get("/").toPromise();

		expect(hits).toBe(1); // client-level maxRetries: 0, not defaultPartition's 2
		expect(client.partitions()).toMatchObject([{ concurrency: DEFAULT_CONCURRENCY }]); // not defaultPartition's 3
	});

	it("keeps the built-in limits when unset", async () => {
		const client = HttpClient.create({ baseUrl: url, timeout: { attemptMs: 5_000 }, retry: { maxRetries: 1 } });
		await client.get("/").toPromise();

		expect(client.partitions()).toMatchObject([
			{ concurrency: DEFAULT_CONCURRENCY, maxQueueSize: DEFAULT_MAX_QUEUE_SIZE },
		]);
	});
});

describe("partitionLookup", () => {
	it("falls back for names that exist on Object.prototype", () => {
		const fallback = { concurrency: 3 };
		const lookup = partitionLookup({ listed: { concurrency: 9 } }, fallback);

		expect(lookup("listed")).toEqual({ concurrency: 9 });
		expect(lookup("unlisted")).toBe(fallback);
		expect(lookup("constructor")).toBe(fallback);
		expect(lookup("__proto__")).toBe(fallback);
	});
});

describe("validateConfig defaultPartition", () => {
	const base = { timeout: { attemptMs: 1_000 } };

	it.each([
		[{ concurrency: 0 }, /defaultPartition\.concurrency must be a positive integer/],
		[{ maxQueueSize: -1 }, /defaultPartition\.maxQueueSize must be a positive integer/],
		[{ retry: { maxRetries: -1 } }, /defaultPartition\.retry\.maxRetries/],
		[{ timeout: { attemptMs: 0 } }, /defaultPartition\.timeout\.attemptMs/],
		[{ circuitBreaker: { failureThreshold: 0 } }, /defaultPartition\.circuitBreaker\.failureThreshold/],
	])("rejects %o", (defaultPartition, message) => {
		expect(() => validateConfig({ ...base, defaultPartition })).toThrow(ConfigurationError);
		expect(() => validateConfig({ ...base, defaultPartition })).toThrow(message);
	});
});
