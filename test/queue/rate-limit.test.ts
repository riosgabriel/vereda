import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpClient } from "../../src/core/client.ts";
import { CancelledError, DeadlineExceededError, RateLimitedError } from "../../src/core/errors.ts";
import type { ClientConfig } from "../../src/core/types.ts";
import { Bulkhead } from "../../src/queue/bulkhead.ts";
import { TokenBucket } from "../../src/queue/rate-limiter.ts";

describe("TokenBucket", () => {
	it("starts full and spaces reservations 1/tokensPerSec apart once empty", () => {
		const bucket = new TokenBucket({ tokensPerSec: 10, burst: 2 }, 0);
		expect([bucket.reserve(0), bucket.reserve(0), bucket.reserve(0), bucket.reserve(0)]).toEqual([0, 0, 100, 200]);
	});

	it("defaults burst to one second's worth, and never below one token", () => {
		expect(new TokenBucket({ tokensPerSec: 5 }, 0).burst).toBe(5);
		expect(new TokenBucket({ tokensPerSec: 0.5 }, 0).burst).toBe(1);
	});

	it("refills with time, capped at burst", () => {
		const bucket = new TokenBucket({ tokensPerSec: 10, burst: 2 }, 0);
		bucket.reserve(0);
		bucket.reserve(0);
		expect(bucket.available(0)).toBe(0);
		expect(bucket.available(150)).toBeCloseTo(1.5);
		expect(bucket.available(10_000)).toBe(2);
		expect(bucket.isFull(10_000)).toBe(true);
	});

	it("refuses, reserving nothing, a wait longer than maxWaitMs", () => {
		const bucket = new TokenBucket({ tokensPerSec: 10, burst: 1, maxWaitMs: 150 }, 0);
		expect(bucket.reserve(0)).toBe(0);
		expect(bucket.reserve(0)).toBe(100);
		expect(bucket.reserve(0)).toBeNull();
		expect(bucket.reserve(0)).toBeNull();
		// Had the refusals reserved, this would be 300ms off, not 150.
		expect(bucket.nextWaitMs(50)).toBe(150);
	});

	it("gives a refunded token to the next caller", () => {
		const bucket = new TokenBucket({ tokensPerSec: 10, burst: 1 }, 0);
		bucket.reserve(0);
		expect(bucket.reserve(0)).toBe(100);
		bucket.refund(0);
		expect(bucket.reserve(0)).toBe(100);
	});
});

describe("Bulkhead.takeToken", () => {
	beforeEach(() => {
		vi.useFakeTimers({ now: 0 });
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("returns undefined without a rate limit, or while a token is free", () => {
		expect(new Bulkhead("a").takeToken()).toBeUndefined();
		expect(new Bulkhead("a", { rateLimit: { tokensPerSec: 1 } }).takeToken()).toBeUndefined();
	});

	it("resolves with the ms waited once the token is due", async () => {
		const bulkhead = new Bulkhead("a", { rateLimit: { tokensPerSec: 10, burst: 1 } });
		expect(bulkhead.takeToken()).toBeUndefined();
		const wait = bulkhead.takeToken();
		await vi.advanceTimersByTimeAsync(100);
		await expect(wait).resolves.toBe(100);
	});

	it("rejects with CancelledError and refunds the token when the signal aborts", async () => {
		const bulkhead = new Bulkhead("a", { rateLimit: { tokensPerSec: 10, burst: 1 } });
		expect(bulkhead.takeToken()).toBeUndefined();
		const controller = new AbortController();
		const wait = bulkhead.takeToken(controller.signal);
		controller.abort();
		await expect(wait).rejects.toBeInstanceOf(CancelledError);
		// The refund means the next caller waits 100ms, not 200.
		const next = bulkhead.takeToken();
		await vi.advanceTimersByTimeAsync(100);
		await expect(next).resolves.toBe(100);
	});

	it("throws RateLimitedError past maxWaitMs", () => {
		const bulkhead = new Bulkhead("api", { rateLimit: { tokensPerSec: 10, burst: 1, maxWaitMs: 50 } });
		expect(bulkhead.takeToken()).toBeUndefined();
		try {
			expect(bulkhead.takeToken()).toBeUndefined();
			expect.unreachable("expected RateLimitedError");
		} catch (err) {
			expect(err).toBeInstanceOf(RateLimitedError);
			expect(err).toMatchObject({ kind: "rate_limited", partition: "api", waitMs: 100, maxWaitMs: 50 });
		}
	});

	it("isn't idle until its bucket refills", () => {
		const bulkhead = new Bulkhead("a", { rateLimit: { tokensPerSec: 10, burst: 1 } });
		expect(bulkhead.takeToken()).toBeUndefined();
		expect(bulkhead.isIdle).toBe(false);
		vi.setSystemTime(100);
		expect(bulkhead.isIdle).toBe(true);
	});
});

describe("rate limit in the client", () => {
	beforeEach(() => {
		vi.useFakeTimers({ now: 0 });
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	/** A client whose fetch records when each attempt was sent and answers
	 *  with the next status in `statuses` (the last one repeats). */
	function setup(config: Partial<ClientConfig>, statuses: number[] = [200]) {
		const sentAt: number[] = [];
		const client = HttpClient.create({
			timeout: { attemptMs: 10_000 },
			retry: { backoff: { baseDelayMs: 0, maxDelayMs: 0, jitter: false } },
			fetch: async () => {
				const status = statuses[Math.min(sentAt.length, statuses.length - 1)];
				sentAt.push(Date.now());
				return new Response(null, { status });
			},
			...config,
		});
		return { client, sentAt };
	}

	it("lets a burst through, then spaces first attempts at tokensPerSec", async () => {
		const { client, sentAt } = setup({ rateLimit: { tokensPerSec: 10, burst: 2 } });
		const results = Array.from({ length: 5 }, (_, i) => client.get(`http://svc.test/${i}`).toPromise());
		await vi.advanceTimersByTimeAsync(1_000);
		await Promise.all(results);
		expect(sentAt).toEqual([0, 0, 100, 200, 300]);
		await client.close();
	});

	it("makes retries take a token too", async () => {
		const { client, sentAt } = setup({ rateLimit: { tokensPerSec: 10, burst: 1 } }, [503, 200]);
		const result = client.get("http://svc.test/x").toPromise();
		await vi.advanceTimersByTimeAsync(1_000);
		expect((await result).success).toBe(true);
		expect(sentAt).toEqual([0, 100]);
		await client.close();
	});

	it("counts the wait for a token in queuedMs", async () => {
		const { client } = setup({ rateLimit: { tokensPerSec: 10, burst: 1 } });
		const queued: number[] = [];
		client.on("success", (e) => queued.push(e.queuedMs));
		const results = [client.get("http://svc.test/a").toPromise(), client.get("http://svc.test/b").toPromise()];
		await vi.advanceTimersByTimeAsync(1_000);
		await Promise.all(results);
		expect(queued).toEqual([0, 100]);
		await client.close();
	});

	it("fails a first attempt past maxWaitMs with RateLimitedError, unsent and not retried", async () => {
		const { client, sentAt } = setup({ rateLimit: { tokensPerSec: 10, burst: 1, maxWaitMs: 50 } });
		const failures: string[] = [];
		client.on("failure", (e) => failures.push(`${e.error.kind}:${e.attempts}`));
		const first = client.get("http://svc.test/a").toPromise();
		const second = await client.get("http://svc.test/b").toPromise();
		expect(second.success).toBe(false);
		if (!second.success) expect(second.error).toBeInstanceOf(RateLimitedError);
		expect(failures).toEqual(["rate_limited:1"]);
		await first;
		expect(sentAt).toEqual([0]);
		await client.close();
	});

	it("fails a retry past maxWaitMs with RateLimitedError, counting only the attempts sent", async () => {
		const { client, sentAt } = setup({ rateLimit: { tokensPerSec: 1, burst: 1, maxWaitMs: 500 } }, [503]);
		const failures: string[] = [];
		client.on("failure", (e) => failures.push(`${e.error.kind}:${e.attempts}`));
		const result = client.get("http://svc.test/x").toPromise();
		await vi.advanceTimersByTimeAsync(10);
		const settled = await result;
		if (!settled.success) expect(settled.error).toBeInstanceOf(RateLimitedError);
		expect(failures).toEqual(["rate_limited:1"]);
		expect(sentAt).toEqual([0]);
		await client.close();
	});

	it("cancels a ticket waiting for its token, which goes to the next request", async () => {
		const { client, sentAt } = setup({ rateLimit: { tokensPerSec: 10, burst: 1 } });
		const cancelled: number[] = [];
		client.on("cancelled", (e) => cancelled.push(e.attempts));
		const first = client.get("http://svc.test/a").toPromise();
		const ticket = client.get("http://svc.test/b");
		ticket.cancel();
		const third = client.get("http://svc.test/c").toPromise();
		await vi.advanceTimersByTimeAsync(1_000);
		await Promise.all([first, third]);
		expect((await ticket.toPromise()).success).toBe(false);
		expect(cancelled).toEqual([1]);
		expect(sentAt).toEqual([0, 100]);
		await client.close();
	});

	it("fails with DeadlineExceededError when totalMs runs out while waiting", async () => {
		const { client, sentAt } = setup({
			timeout: { attemptMs: 10_000, totalMs: 50 },
			rateLimit: { tokensPerSec: 1, burst: 1 },
		});
		const first = client.get("http://svc.test/a").toPromise();
		const second = client.get("http://svc.test/b").toPromise();
		await vi.advanceTimersByTimeAsync(100);
		const result = await second;
		if (!result.success) expect(result.error).toBeInstanceOf(DeadlineExceededError);
		else expect.unreachable("expected a deadline failure");
		await first;
		expect(sentAt).toEqual([0]);
		await client.close();
	});

	it("reports available tokens in partitions(), only for rate-limited partitions", async () => {
		const { client } = setup({ rateLimit: { tokensPerSec: 10, burst: 3 } });
		await client.get("http://svc.test/a").toPromise();
		const svc = client.partitions().find((p) => p.name === "svc.test");
		expect(svc?.tokens).toBe(2);
		await client.close();

		const { client: plain } = setup({});
		await plain.get("http://svc.test/a").toPromise();
		expect(plain.partitions()[0]).not.toHaveProperty("tokens");
		await plain.close();
	});

	it("lets a partition opt out of the client's rate limit with false", async () => {
		const { client, sentAt } = setup({
			rateLimit: { tokensPerSec: 1, burst: 1 },
			partitions: { "free.test": { rateLimit: false } },
		});
		const results = [client.get("http://free.test/a").toPromise(), client.get("http://free.test/b").toPromise()];
		await vi.advanceTimersByTimeAsync(10);
		await Promise.all(results);
		expect(sentAt).toEqual([0, 0]);
		expect(client.partitions()[0]).not.toHaveProperty("tokens");
		await client.close();
	});

	it("merges a partition's rateLimit over the client's, field by field", async () => {
		const { client, sentAt } = setup({
			rateLimit: { tokensPerSec: 10, burst: 1 },
			partitions: { "slow.test": { rateLimit: { tokensPerSec: 2 } } },
		});
		const results = [client.get("http://slow.test/a").toPromise(), client.get("http://slow.test/b").toPromise()];
		await vi.advanceTimersByTimeAsync(1_000);
		await Promise.all(results);
		// tokensPerSec from the partition, burst 1 from the client.
		expect(sentAt).toEqual([0, 500]);
		await client.close();
	});
});
