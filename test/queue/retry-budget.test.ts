import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpClient } from "../../src/core/client.ts";
import { RetryableStatusError } from "../../src/core/errors.ts";
import { METRICS, type MetricsSink } from "../../src/core/metrics.ts";
import { partitionLookup } from "../../src/core/types.ts";
import { RetryBudget, RetryBudgetRegistry } from "../../src/queue/retry-budget.ts";

describe("RetryBudget", () => {
	it("always admits when unconfigured", () => {
		const budget = new RetryBudget();
		expect(budget.enabled).toBe(false);
		for (let i = 0; i < 100; i++) expect(budget.tryWithdraw()).toBe(true);
	});

	it("admits retries up to ratio * requests in the window", () => {
		const budget = new RetryBudget({ ratio: 0.5, windowMs: 1_000, minRetriesPerSec: 0 });
		for (let i = 0; i < 4; i++) budget.recordRequest(0);
		expect(budget.tryWithdraw(0)).toBe(true);
		expect(budget.tryWithdraw(0)).toBe(true);
		expect(budget.tryWithdraw(0)).toBe(false);
	});

	it("lets minRetriesPerSec * window seconds through with no traffic", () => {
		const budget = new RetryBudget({ ratio: 0.1, windowMs: 2_000, minRetriesPerSec: 1 });
		expect(budget.tryWithdraw(0)).toBe(true);
		expect(budget.tryWithdraw(0)).toBe(true);
		expect(budget.tryWithdraw(0)).toBe(false);
	});

	it("defaults minRetriesPerSec to 10", () => {
		const budget = new RetryBudget({ ratio: 0, windowMs: 1_000 });
		for (let i = 0; i < 10; i++) expect(budget.tryWithdraw(0)).toBe(true);
		expect(budget.tryWithdraw(0)).toBe(false);
	});

	it("refuses every retry with ratio 0 and no floor", () => {
		const budget = new RetryBudget({ ratio: 0, windowMs: 1_000, minRetriesPerSec: 0 });
		budget.recordRequest(0);
		expect(budget.tryWithdraw(0)).toBe(false);
	});

	it("does not spend budget on a refused retry", () => {
		const budget = new RetryBudget({ ratio: 1, windowMs: 1_000, minRetriesPerSec: 0 });
		expect(budget.tryWithdraw(0)).toBe(false);
		expect(budget.tryWithdraw(0)).toBe(false);
		// One request now funds exactly one retry; the refusals above cost nothing.
		budget.recordRequest(0);
		expect(budget.tryWithdraw(0)).toBe(true);
		expect(budget.tryWithdraw(0)).toBe(false);
	});

	it("recovers once spent retries slide out of the window", () => {
		const budget = new RetryBudget({ ratio: 1, windowMs: 1_000, minRetriesPerSec: 0 });
		budget.recordRequest(0);
		expect(budget.tryWithdraw(0)).toBe(true);
		budget.recordRequest(500);
		expect(budget.tryWithdraw(500)).toBe(true);
		expect(budget.tryWithdraw(500)).toBe(false);
		// The t=0 request and retry have aged out; the t=500 pair hasn't.
		budget.recordRequest(1_100);
		expect(budget.tryWithdraw(1_100)).toBe(true);
		expect(budget.tryWithdraw(1_100)).toBe(false);
	});

	it("is not evictable while held or while its window still counts traffic", () => {
		const budget = new RetryBudget({ ratio: 1, windowMs: 1_000 });
		const release = budget.retain();
		expect(budget.isEvictable(0)).toBe(false);
		budget.recordRequest(0);
		release();
		release(); // idempotent
		expect(budget.isEvictable(500)).toBe(false);
		expect(budget.isEvictable(2_000)).toBe(true);
	});
});

describe("RetryBudgetRegistry", () => {
	beforeEach(() => {
		vi.useFakeTimers({ now: 0 });
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("merges the partition budget over the global one, field by field", () => {
		const registry = new RetryBudgetRegistry(
			{ ratio: 0, windowMs: 1_000, minRetriesPerSec: 0 },
			partitionLookup({ b: { retryBudget: { ratio: 1, windowMs: 1_000 } } }),
		);
		const a = registry.get("a");
		const b = registry.get("b");
		a.recordRequest();
		b.recordRequest();
		expect(a.tryWithdraw()).toBe(false);
		// b keeps the global minRetriesPerSec: 0, so only its ratio funds this.
		expect(b.tryWithdraw()).toBe(true);
		expect(b.tryWithdraw()).toBe(false);
	});

	it("hands out an inert budget when nothing is configured", () => {
		const registry = new RetryBudgetRegistry(undefined, partitionLookup());
		expect(registry.get("a").enabled).toBe(false);
	});

	it("keeps an idle partition's budget until its window empties", () => {
		const registry = new RetryBudgetRegistry(
			{ ratio: 0, windowMs: 120_000, minRetriesPerSec: 0 },
			partitionLookup(),
			1_000,
		);
		const budget = registry.get("a");
		budget.recordRequest();
		vi.setSystemTime(60_000);
		registry.prune();
		expect(registry.get("a")).toBe(budget);
		vi.setSystemTime(300_000);
		registry.prune();
		expect(registry.get("a")).not.toBe(budget);
	});
});

describe("retry budget in the client", () => {
	const unavailable = () => new Response("busy", { status: 503 });

	it("fails with the last error, without waiting, once the budget is spent", async () => {
		let calls = 0;
		const counters: string[] = [];
		const sink: MetricsSink = {
			counter: (name) => counters.push(name),
			histogram: () => {},
			gauge: () => {},
		};
		const client = HttpClient.create({
			fetch: async () => {
				calls++;
				return unavailable();
			},
			metrics: sink,
			timeout: { attemptMs: 1_000 },
			// A 60s backoff: if the refusal waited first, the test would time out.
			retry: { maxRetries: 3, backoff: { baseDelayMs: 60_000, maxDelayMs: 60_000, jitter: false } },
			retryBudget: { ratio: 0, windowMs: 10_000, minRetriesPerSec: 0 },
		});
		const events: string[] = [];
		client.on("retry", () => events.push("retry"));
		client.on("retryBudgetExhausted", (e) => events.push(`exhausted:${e.partition}`));
		client.on("failure", (e) => events.push(`failure:${e.attempts}`));

		const result = await client.get("http://svc.test/x").toPromise();

		expect(result.success).toBe(false);
		if (!result.success) expect(result.error).toBeInstanceOf(RetryableStatusError);
		expect(calls).toBe(1);
		expect(events).toEqual(["exhausted:svc.test", "failure:1"]);
		expect(counters).toContain(METRICS.RETRY_BUDGET_EXHAUSTED);
		await client.close();
	});

	it("bounds load on a failing host to about 1 + ratio", async () => {
		let calls = 0;
		const client = HttpClient.create({
			fetch: async () => {
				calls++;
				return unavailable();
			},
			timeout: { attemptMs: 1_000 },
			retry: { maxRetries: 3, backoff: { baseDelayMs: 1, maxDelayMs: 1, jitter: false } },
			retryBudget: { ratio: 0.5, windowMs: 10_000, minRetriesPerSec: 0 },
		});

		const tickets = Array.from({ length: 20 }, (_, i) => client.get(`http://svc.test/${i}`).toPromise());
		await Promise.all(tickets);

		// 20 first attempts fund 10 retries; without the budget it'd be 80 calls.
		expect(calls).toBe(30);
		await client.close();
	});

	it("does not limit retries when no budget is configured", async () => {
		let calls = 0;
		const client = HttpClient.create({
			fetch: async () => {
				calls++;
				return unavailable();
			},
			timeout: { attemptMs: 1_000 },
			retry: { maxRetries: 3, backoff: { baseDelayMs: 1, maxDelayMs: 1, jitter: false } },
		});

		await Promise.all(Array.from({ length: 5 }, (_, i) => client.get(`http://svc.test/${i}`).toPromise()));

		expect(calls).toBe(20);
		await client.close();
	});
});
