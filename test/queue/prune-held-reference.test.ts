import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpClient } from "../../src/core/client.ts";
import { DEFAULT_PARTITION_TTL_MS } from "../../src/queue/bulkhead.ts";
import { PartitionRegistry } from "../../src/queue/partition-registry.ts";

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

// The rule above lives in PartitionRegistry once; bulkheads, breakers and
// retry budgets only supply their own isEvictable.
describe("PartitionRegistry", () => {
	const TTL_MS = 1_000;

	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	function makeRegistry() {
		const created: string[] = [];
		const registry = new PartitionRegistry((name) => {
			created.push(name);
			return {
				name,
				evictable: true,
				isEvictable: function (this: { evictable: boolean }) {
					return this.evictable;
				},
			};
		}, TTL_MS);
		return { registry, created };
	}

	it("returns the same entry until it is evicted", () => {
		const { registry, created } = makeRegistry();
		const first = registry.get("a");
		expect(registry.get("a")).toBe(first);
		expect(created).toEqual(["a"]);
	});

	it("keeps an entry the TTL has not yet elapsed for, even if evictable", () => {
		const { registry } = makeRegistry();
		const entry = registry.get("a");
		vi.advanceTimersByTime(TTL_MS);
		registry.prune();
		expect(registry.get("a")).toBe(entry);
	});

	it("keeps an entry past the TTL while isEvictable says it is still in use", () => {
		const { registry } = makeRegistry();
		const entry = registry.get("a");
		entry.evictable = false;
		vi.advanceTimersByTime(TTL_MS + 1);
		registry.prune();
		expect(registry.get("a")).toBe(entry);

		vi.advanceTimersByTime(TTL_MS + 1);
		entry.evictable = true;
		registry.prune();
		expect(registry.get("a")).not.toBe(entry);
	});

	it("sweeps on every tenth get", () => {
		const { registry } = makeRegistry();
		const stale = registry.get("stale");
		vi.advanceTimersByTime(TTL_MS + 1);
		// Calls 2..9 touch only "live", never "stale"; the tenth sweeps.
		for (let i = 0; i < 8; i++) registry.get("live");
		expect([...registry.values()]).toContain(stale);
		registry.get("live");
		expect([...registry.values()]).not.toContain(stale);
	});

	it("sweeps on any get once the map passes 100 entries", () => {
		const { registry } = makeRegistry();
		const stale = registry.get("stale");
		stale.evictable = false;
		vi.advanceTimersByTime(TTL_MS + 1);
		// Calls 2..100 reach 100 entries, sweeping on the 10th multiples only.
		for (let i = 0; i < 99; i++) registry.get(`p${i}`);
		stale.evictable = true;
		expect([...registry.values()]).toContain(stale);
		registry.get("p99"); // 101 entries on call 101: not a multiple of 10
		expect([...registry.values()]).not.toContain(stale);
	});

	it("values() and delete() don't refresh last access", () => {
		const { registry } = makeRegistry();
		const entry = registry.get("a");
		vi.advanceTimersByTime(TTL_MS + 1);
		expect([...registry.values()]).toEqual([entry]);
		registry.prune();
		expect([...registry.values()]).toEqual([]);

		const other = registry.get("b");
		registry.delete("b");
		expect(registry.get("b")).not.toBe(other);
	});
});
