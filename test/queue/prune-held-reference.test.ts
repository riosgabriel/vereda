import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpClient } from "../../src/core/client.ts";
import { DEFAULT_PARTITION_TTL_MS } from "../../src/queue/bulkhead.ts";

type Registries = {
	bulkheads: { get(name: string): unknown; prune(): void };
	circuitBreakers: { get(name: string): unknown; prune(): void };
};

// B12: a ticket keeps the bulkhead/breaker it fetched across retry backoff,
// when nothing is running or queued. Pruning must not orphan them.
describe("registry prune vs. tickets in retry backoff", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("keeps the bulkhead and breaker of a ticket that is in retry backoff past the TTL", async () => {
		const fetchMock = vi.fn(async () => new Response("unavailable", { status: 503 }));
		const client = HttpClient.create({
			fetch: fetchMock as unknown as typeof globalThis.fetch,
			timeout: { attemptMs: 5_000 },
			retry: { maxRetries: 1, backoff: { baseDelayMs: 300_000, maxDelayMs: 300_000, jitter: false } },
			circuitBreaker: { enabled: true, failureThreshold: 100 },
		});
		const registries = client as unknown as Registries;

		const pending = client.get("http://a.test/x", { partition: "a" }).toPromise();
		await vi.advanceTimersByTimeAsync(1_000);
		expect(fetchMock).toHaveBeenCalledTimes(1);

		const bulkhead = registries.bulkheads.get("a");
		const breaker = registries.circuitBreakers.get("a");

		// Idle past the TTL while the ticket sleeps; a sweep runs.
		await vi.advanceTimersByTimeAsync(DEFAULT_PARTITION_TTL_MS + 1_000);
		registries.bulkheads.prune();
		registries.circuitBreakers.prune();

		expect(registries.bulkheads.get("a")).toBe(bulkhead);
		expect(registries.circuitBreakers.get("a")).toBe(breaker);

		// Once the ticket settles, the holds are released and the entries age out.
		await vi.advanceTimersByTimeAsync(300_000);
		await pending;
		await vi.advanceTimersByTimeAsync(DEFAULT_PARTITION_TTL_MS + 1_000);
		registries.bulkheads.prune();
		registries.circuitBreakers.prune();
		expect(registries.bulkheads.get("a")).not.toBe(bulkhead);
		expect(registries.circuitBreakers.get("a")).not.toBe(breaker);
	});
});
