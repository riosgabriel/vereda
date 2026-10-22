import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpClient } from "../../src/core/client.ts";
import {
	CancelledError,
	DeadlineExceededError,
	RateLimitedError,
	RetryableStatusError,
} from "../../src/core/errors.ts";
import type { ClientConfig } from "../../src/core/types.ts";
import { Bulkhead, BulkheadRegistry } from "../../src/queue/bulkhead.ts";
import { PartitionPause } from "../../src/queue/pause.ts";
import { TokenBucket } from "../../src/queue/rate-limiter.ts";

function pushback(statusCode: number, retryAfterMs?: number): RetryableStatusError {
	return new RetryableStatusError("pushback", statusCode, new Response(null, { status: statusCode }), retryAfterMs);
}

describe("PartitionPause", () => {
	it("extends to now + the delay, clamped to maxPauseMs", () => {
		const pause = new PartitionPause({ maxPauseMs: 5_000 });
		expect(pause.extend(2_000, 100)).toBe(2_100);
		expect(pause.remaining(100)).toBe(2_000);
		expect(pause.extend(60_000, 3_000)).toBe(8_000);
		expect(pause.remaining(9_000)).toBe(0);
	});

	it("never shortens", () => {
		const pause = new PartitionPause({});
		pause.extend(10_000, 0);
		expect(pause.extend(1_000, 0)).toBe(10_000);
		expect(pause.extend(1_000, 9_500)).toBe(10_500);
	});

	it("defaults to 429 and 503, and 30s", () => {
		const pause = new PartitionPause({});
		expect(pause.statuses).toEqual([429, 503]);
		expect(pause.extend(60_000, 0)).toBe(30_000);
	});
});

describe("TokenBucket.freezeUntil", () => {
	it("drains the bucket and makes the wait run from the freeze point", () => {
		const bucket = new TokenBucket({ tokensPerSec: 10, burst: 3 }, 0);
		bucket.freezeUntil(1_000, 0);
		expect(bucket.available(500)).toBe(0);
		expect(bucket.isFull(500)).toBe(false);
		// 500ms to the thaw, then one token's worth of refill.
		expect(bucket.nextWaitMs(500)).toBe(600);
		expect(bucket.reserve(500)).toBe(600);
		expect(bucket.reserve(500)).toBe(700);
	});

	it("keeps reservations already made owed", () => {
		const bucket = new TokenBucket({ tokensPerSec: 10, burst: 1 }, 0);
		bucket.reserve(0);
		bucket.reserve(0);
		bucket.freezeUntil(500, 0);
		expect(bucket.reserve(0)).toBe(700);
	});

	it("reserves as of a later time with `at`", () => {
		const bucket = new TokenBucket({ tokensPerSec: 10, burst: 1 }, 0);
		expect(bucket.reserve(0, 1_000)).toBe(1_000);
		expect(bucket.reserve(0, 1_000)).toBe(1_100);
	});
});

describe("Bulkhead pause", () => {
	beforeEach(() => {
		vi.useFakeTimers({ now: 0 });
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("ignores errors that are not a listed status with a positive Retry-After", () => {
		const bulkhead = new Bulkhead("a", { pauseOnRetryAfter: {} });
		bulkhead.notePushback(new Error("boom"));
		bulkhead.notePushback(pushback(500, 1_000));
		bulkhead.notePushback(pushback(429));
		bulkhead.notePushback(pushback(429, 0));
		expect(bulkhead.pausedUntil).toBeUndefined();
		expect(bulkhead.takeToken()).toBeUndefined();
	});

	it("does nothing when pauseOnRetryAfter isn't configured", () => {
		const bulkhead = new Bulkhead("a");
		bulkhead.notePushback(pushback(429, 1_000));
		expect(bulkhead.pausedUntil).toBeUndefined();
		expect(bulkhead.takeToken()).toBeUndefined();
	});

	it("waits out the pause and resolves with the ms waited", async () => {
		const bulkhead = new Bulkhead("a", { pauseOnRetryAfter: {} });
		bulkhead.notePushback(pushback(429, 2_000));
		expect(bulkhead.pausedUntil).toBe(2_000);
		const wait = bulkhead.takeToken();
		await vi.advanceTimersByTimeAsync(2_000);
		await expect(wait).resolves.toBe(2_000);
		expect(bulkhead.pausedUntil).toBeUndefined();
	});

	it("doesn't shorten a pause for a smaller Retry-After", () => {
		const bulkhead = new Bulkhead("a", { pauseOnRetryAfter: {} });
		bulkhead.notePushback(pushback(429, 10_000));
		bulkhead.notePushback(pushback(429, 1_000));
		expect(bulkhead.pausedUntil).toBe(10_000);
	});

	it("waits again when the pause is extended while it sleeps", async () => {
		const bulkhead = new Bulkhead("a", { pauseOnRetryAfter: {} });
		bulkhead.notePushback(pushback(429, 1_000));
		let settled = false;
		const wait = bulkhead.takeToken()?.then((ms) => {
			settled = true;
			return ms;
		});
		await vi.advanceTimersByTimeAsync(500);
		bulkhead.notePushback(pushback(429, 2_000));
		await vi.advanceTimersByTimeAsync(600);
		expect(settled).toBe(false);
		await vi.advanceTimersByTimeAsync(1_400);
		await expect(wait).resolves.toBe(2_500);
	});

	it("keeps waiters spaced at tokensPerSec when the pause is extended while they sleep", async () => {
		const bulkhead = new Bulkhead("a", {
			pauseOnRetryAfter: {},
			rateLimit: { tokensPerSec: 10, burst: 1 },
		});
		bulkhead.notePushback(pushback(429, 1_000));
		const sentAt: number[] = [];
		const waits = [0, 1, 2].map(() => bulkhead.takeToken()?.then(() => sentAt.push(Date.now())));
		await vi.advanceTimersByTimeAsync(500);
		bulkhead.notePushback(pushback(429, 2_000));
		await vi.advanceTimersByTimeAsync(3_000);
		await Promise.all(waits);
		// Not all three at 2_500: each keeps its place behind the new end.
		expect(sentAt).toEqual([2_600, 2_700, 2_800]);
	});

	it("rejects with CancelledError on abort, and refunds the token", async () => {
		const bulkhead = new Bulkhead("a", {
			pauseOnRetryAfter: {},
			rateLimit: { tokensPerSec: 10, burst: 2 },
		});
		bulkhead.notePushback(pushback(429, 1_000));
		const controller = new AbortController();
		const wait = bulkhead.takeToken(controller.signal);
		controller.abort();
		await expect(wait).rejects.toBeInstanceOf(CancelledError);
		// Had the token not come back, this one would wait 100ms longer.
		const next = bulkhead.takeToken();
		await vi.advanceTimersByTimeAsync(1_100);
		await expect(next).resolves.toBe(1_100);
	});

	it("throws RateLimitedError, reserving nothing, when pause + token wait exceed maxWaitMs", async () => {
		const bulkhead = new Bulkhead("a", {
			pauseOnRetryAfter: {},
			rateLimit: { tokensPerSec: 10, burst: 1, maxWaitMs: 1_000 },
		});
		bulkhead.notePushback(pushback(429, 2_000));
		expect(() => bulkhead.takeToken()).toThrow(RateLimitedError);
		// Nothing was reserved by the refusal: after the pause, the drained
		// bucket makes the next caller wait one token's refill, not two.
		vi.setSystemTime(2_000);
		const next = bulkhead.takeToken();
		await vi.advanceTimersByTimeAsync(100);
		await expect(next).resolves.toBe(100);
	});

	it("isn't idle while paused", () => {
		const bulkhead = new Bulkhead("a", { pauseOnRetryAfter: {} });
		bulkhead.notePushback(pushback(429, 2_000));
		expect(bulkhead.isIdle).toBe(false);
		vi.setSystemTime(2_000);
		expect(bulkhead.isIdle).toBe(true);
	});
});

describe("BulkheadRegistry pause", () => {
	beforeEach(() => {
		vi.useFakeTimers({ now: 0 });
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("prune keeps a paused partition, and evicts it after the pause plus the TTL", () => {
		const registry = new BulkheadRegistry({ pauseOnRetryAfter: { maxPauseMs: 5_000 } }, {}, 1_000);
		registry.get("a").notePushback(pushback(429, 5_000));
		vi.setSystemTime(4_000);
		registry.prune();
		expect(registry.getAll()).toHaveLength(1);
		vi.setSystemTime(5_001);
		registry.prune();
		expect(registry.getAll()).toHaveLength(0);
	});

	it("shows pausedUntil in snapshots only while the pause is active", () => {
		const registry = new BulkheadRegistry({ pauseOnRetryAfter: {} });
		registry.get("a").notePushback(pushback(429, 2_000));
		expect(registry.getAll()[0]?.pausedUntil).toBe(2_000);
		vi.setSystemTime(2_000);
		expect(registry.getAll()[0]).not.toHaveProperty("pausedUntil");
	});

	it("merges field by field, and false per partition overrides the client", () => {
		const registry = new BulkheadRegistry(
			{ pauseOnRetryAfter: { statuses: [429] } },
			{ slow: { pauseOnRetryAfter: { maxPauseMs: 1_000 } }, free: { pauseOnRetryAfter: false } },
		);
		const slow = registry.get("slow");
		slow.notePushback(pushback(503, 5_000));
		expect(slow.pausedUntil).toBeUndefined();
		slow.notePushback(pushback(429, 5_000));
		expect(slow.pausedUntil).toBe(1_000);
		const free = registry.get("free");
		free.notePushback(pushback(429, 5_000));
		expect(free.pausedUntil).toBeUndefined();
	});
});

describe("pauseOnRetryAfter in the client", () => {
	beforeEach(() => {
		vi.useFakeTimers({ now: 0 });
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	interface Reply {
		status: number;
		retryAfter?: string;
	}

	/** A client whose fetch records when each attempt was sent and answers
	 *  with the next reply in `replies` (the last one repeats). */
	function setup(config: Partial<ClientConfig>, replies: Reply[]) {
		const sentAt: number[] = [];
		const client = HttpClient.create({
			timeout: { attemptMs: 10_000 },
			retry: { maxRetries: 0, backoff: { baseDelayMs: 0, maxDelayMs: 0, jitter: false } },
			pauseOnRetryAfter: {},
			fetch: async () => {
				const reply = replies[Math.min(sentAt.length, replies.length - 1)]!;
				sentAt.push(Date.now());
				const headers = reply.retryAfter === undefined ? undefined : { "retry-after": reply.retryAfter };
				return new Response(null, { status: reply.status, headers });
			},
			...config,
		});
		return { client, sentAt };
	}

	const ok: Reply = { status: 200 };
	const url = (path: string) => `http://svc.test/${path}`;

	it("holds another ticket's first attempt until the Retry-After is over, counted in queuedMs", async () => {
		const { client, sentAt } = setup({}, [{ status: 429, retryAfter: "2" }, ok]);
		const queued: number[] = [];
		client.on("success", (e) => queued.push(e.queuedMs));
		await client.get(url("a")).toPromise();
		const second = client.get(url("b")).toPromise();
		await vi.advanceTimersByTimeAsync(1_999);
		expect(sentAt).toEqual([0]);
		await vi.advanceTimersByTimeAsync(1);
		expect((await second).success).toBe(true);
		expect(sentAt).toEqual([0, 2_000]);
		expect(queued).toEqual([2_000]);
		await client.close();
	});

	it("reads an HTTP-date Retry-After the same way", async () => {
		const { client, sentAt } = setup({}, [{ status: 429, retryAfter: new Date(2_000).toUTCString() }, ok]);
		await client.get(url("a")).toPromise();
		const second = client.get(url("b")).toPromise();
		await vi.advanceTimersByTimeAsync(2_000);
		await second;
		expect(sentAt).toEqual([0, 2_000]);
		await client.close();
	});

	it.each(["0", "-5", "1.5", "soon", new Date(0).toUTCString()])(
		"doesn't pause for Retry-After %j",
		async (retryAfter) => {
			const { client, sentAt } = setup({}, [{ status: 429, retryAfter }, ok]);
			await client.get(url("a")).toPromise();
			expect(client.partitions()[0]).not.toHaveProperty("pausedUntil");
			await client.get(url("b")).toPromise();
			expect(sentAt).toEqual([0, 0]);
			await client.close();
		},
	);

	it("clamps a longer Retry-After to maxPauseMs", async () => {
		const { client, sentAt } = setup({ pauseOnRetryAfter: { maxPauseMs: 3_000 } }, [
			{ status: 429, retryAfter: "3600" },
			ok,
		]);
		await client.get(url("a")).toPromise();
		const second = client.get(url("b")).toPromise();
		await vi.advanceTimersByTimeAsync(3_000);
		await second;
		expect(sentAt).toEqual([0, 3_000]);
		await client.close();
	});

	it("extends the pause on a later 429 that ends after it, and holds the next ticket for it", async () => {
		const { client, sentAt } = setup({}, [{ status: 429, retryAfter: "5" }, { status: 429, retryAfter: "1" }, ok]);
		await client.get(url("a")).toPromise();
		const second = client.get(url("b")).toPromise();
		await vi.advanceTimersByTimeAsync(5_000);
		await second;
		expect(sentAt).toEqual([0, 5_000]);
		expect(client.partitions()[0]?.pausedUntil).toBe(6_000);

		const third = client.get(url("c")).toPromise();
		await vi.advanceTimersByTimeAsync(1_000);
		await third;
		expect(sentAt).toEqual([0, 5_000, 6_000]);
		await client.close();
	});

	it("makes a waiter whose timer fires during an extension wait again", async () => {
		const bulkhead = new Bulkhead("a", { pauseOnRetryAfter: {} });
		bulkhead.notePushback(pushback(429, 1_000));
		const sentAt: number[] = [];
		const waiter = bulkhead.takeToken()?.then(() => sentAt.push(Date.now()));
		await vi.advanceTimersByTimeAsync(900);
		bulkhead.notePushback(pushback(429, 3_000));
		await vi.advanceTimersByTimeAsync(2_999);
		expect(sentAt).toEqual([]);
		await vi.advanceTimersByTimeAsync(1);
		await waiter;
		expect(sentAt).toEqual([3_900]);
	});

	it("cancel() during a pause cancels the ticket, once, and sends nothing", async () => {
		const { client, sentAt } = setup({}, [{ status: 429, retryAfter: "2" }, ok]);
		const events: string[] = [];
		client.on("success", () => events.push("success"));
		client.on("failure", () => events.push("failure"));
		client.on("cancelled", () => events.push("cancelled"));
		await client.get(url("a")).toPromise();
		events.length = 0;
		const ticket = client.get(url("b"));
		await vi.advanceTimersByTimeAsync(500);
		ticket.cancel();
		const result = await ticket.toPromise();
		expect(!result.success && result.error).toBeInstanceOf(CancelledError);
		await vi.advanceTimersByTimeAsync(0);
		expect(events).toEqual(["cancelled"]);
		await vi.advanceTimersByTimeAsync(5_000);
		expect(sentAt).toEqual([0]);
		await client.close();
	});

	it("refunds the token of a ticket cancelled during a pause", async () => {
		const { client, sentAt } = setup({ rateLimit: { tokensPerSec: 10, burst: 2 } }, [
			{ status: 429, retryAfter: "2" },
			ok,
		]);
		await client.get(url("a")).toPromise();
		const doomed = client.get(url("b"));
		doomed.cancel();
		const third = client.get(url("c")).toPromise();
		await vi.advanceTimersByTimeAsync(5_000);
		await third;
		// The pause ends at 2000 and the freeze leaves no tokens, so c goes one
		// token's refill later. Had b kept its reservation, it would be 2200.
		expect(sentAt).toEqual([0, 2_100]);
		await client.close();
	});

	it("fails with one DeadlineExceededError when totalMs runs out during a pause", async () => {
		const { client, sentAt } = setup({ timeout: { attemptMs: 10_000, totalMs: 1_000 } }, [
			{ status: 429, retryAfter: "5" },
			ok,
		]);
		const events: string[] = [];
		client.on("success", () => events.push("success"));
		client.on("failure", (e) => events.push(`failure:${e.error.kind}`));
		client.on("cancelled", () => events.push("cancelled"));
		await client.get(url("a")).toPromise();
		events.length = 0;
		const second = client.get(url("b")).toPromise();
		await vi.advanceTimersByTimeAsync(1_500);
		const result = await second;
		expect(!result.success && result.error).toBeInstanceOf(DeadlineExceededError);
		expect(events).toHaveLength(1);
		expect(events[0]).toMatch(/^failure:/);
		expect(sentAt).toEqual([0]);
		await client.close();
	});

	it("fails with RateLimitedError, unsent, when maxWaitMs is shorter than the pause", async () => {
		const { client, sentAt } = setup({ rateLimit: { tokensPerSec: 10, burst: 5, maxWaitMs: 1_000 } }, [
			{ status: 429, retryAfter: "5" },
			ok,
		]);
		await client.get(url("a")).toPromise();
		const result = await client.get(url("b")).toPromise();
		expect(!result.success && result.error).toBeInstanceOf(RateLimitedError);
		expect(sentAt).toEqual([0]);
		await client.close();
	});

	it("resumes at tokensPerSec after the pause, not in a burst", async () => {
		const { client, sentAt } = setup({ rateLimit: { tokensPerSec: 10, burst: 5 } }, [
			{ status: 429, retryAfter: "2" },
			ok,
		]);
		await client.get(url("a")).toPromise();
		const rest = ["b", "c", "d"].map((p) => client.get(url(p)).toPromise());
		await vi.advanceTimersByTimeAsync(3_000);
		await Promise.all(rest);
		expect(sentAt).toEqual([0, 2_100, 2_200, 2_300]);
		await client.close();
	});

	it("holds a retry for the longer of its own delay and the pause", async () => {
		const { client, sentAt } = setup(
			{
				retry: { maxRetries: 1, backoff: { baseDelayMs: 500, maxDelayMs: 500, jitter: false } },
			},
			[{ status: 429, retryAfter: "2" }, ok],
		);
		const result = client.get(url("a")).toPromise();
		await vi.advanceTimersByTimeAsync(1_999);
		expect(sentAt).toEqual([0]);
		await vi.advanceTimersByTimeAsync(1);
		expect((await result).success).toBe(true);
		expect(sentAt).toEqual([0, 2_000]);
		await client.close();
	});

	it("fails a retry at once when the pause alone would pass the deadline", async () => {
		const { client, sentAt } = setup(
			{
				timeout: { attemptMs: 10_000, totalMs: 1_000 },
				retry: { maxRetries: 1, backoff: { baseDelayMs: 0, maxDelayMs: 0, jitter: false } },
			},
			[{ status: 429, retryAfter: "5" }, ok],
		);
		const result = await client.get(url("a")).toPromise();
		expect(!result.success && result.error).toBeInstanceOf(DeadlineExceededError);
		expect(Date.now()).toBe(0);
		expect(sentAt).toEqual([0]);
		await client.close();
	});

	it("shows pausedUntil in partitions(), then drops it", async () => {
		const { client } = setup({}, [{ status: 429, retryAfter: "2" }]);
		await client.get(url("a")).toPromise();
		expect(client.partitions()[0]?.pausedUntil).toBe(2_000);
		await vi.advanceTimersByTimeAsync(2_000);
		expect(client.partitions()[0]).not.toHaveProperty("pausedUntil");
		await client.close();
	});

	it("lets false on a partition override the client", async () => {
		const { client, sentAt } = setup({ partitions: { "svc.test": { pauseOnRetryAfter: false } } }, [
			{ status: 429, retryAfter: "2" },
			ok,
		]);
		await client.get(url("a")).toPromise();
		await client.get(url("b")).toPromise();
		expect(sentAt).toEqual([0, 0]);
		await client.close();
	});

	it("pauses on 503 by default, but not on a status that isn't listed", async () => {
		const { client } = setup({}, [{ status: 503, retryAfter: "2" }, ok]);
		await client.get(url("a")).toPromise();
		expect(client.partitions()[0]?.pausedUntil).toBe(2_000);
		await client.close();

		const only429 = setup({ pauseOnRetryAfter: { statuses: [429] } }, [{ status: 503, retryAfter: "2" }, ok]);
		await only429.client.get(url("a")).toPromise();
		await only429.client.get(url("b")).toPromise();
		expect(only429.sentAt).toEqual([0, 0]);
		await only429.client.close();
	});

	it("does nothing unless configured", async () => {
		const { client, sentAt } = setup({ pauseOnRetryAfter: undefined }, [{ status: 429, retryAfter: "2" }, ok]);
		await client.get(url("a")).toPromise();
		await client.get(url("b")).toPromise();
		expect(sentAt).toEqual([0, 0]);
		await client.close();
	});
});

describe("a pause also holds attempts that were already queued", () => {
	beforeEach(() => {
		vi.useFakeTimers({ now: 0 });
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	const url = (host: string, path: string) => `http://${host}/${path}`;
	const sleepMs = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

	/** fetch answers per path: `slow429` after 100 ms with Retry-After 5,
	 *  `flaky` with 500 once and then 200, anything else 200. Records the
	 *  time of every call as `path@host`. */
	function setup(config: Partial<ClientConfig>) {
		const calls: Array<{ key: string; at: number }> = [];
		const seen = new Map<string, number>();
		const client = HttpClient.create({
			timeout: { attemptMs: 10_000 },
			retry: { maxRetries: 0, backoff: { baseDelayMs: 0, maxDelayMs: 0, jitter: false } },
			pauseOnRetryAfter: {},
			fetch: async (input) => {
				const u = new URL(String(input));
				const key = `${u.pathname.slice(1)}@${u.host}`;
				calls.push({ key, at: Date.now() });
				const n = (seen.get(key) ?? 0) + 1;
				seen.set(key, n);
				if (u.pathname === "/slow429") {
					await sleepMs(100);
					return new Response(null, { status: 429, headers: { "retry-after": "5" } });
				}
				if (u.pathname === "/flaky" && n === 1) return new Response(null, { status: 500 });
				return new Response(null, { status: 200 });
			},
			...config,
		});
		return { client, calls };
	}

	const partitionQueue = { defaultPartition: { concurrency: 1, limitFirstAttempts: true } };

	it("holds an attempt queued in the partition bulkhead until the pause is over", async () => {
		const { client, calls } = setup(partitionQueue);
		void client.get(url("svc.test", "slow429")).toPromise();
		const b = client.get(url("svc.test", "b")).toPromise();
		await vi.advanceTimersByTimeAsync(4_999);
		expect(calls.map((c) => c.key)).toEqual(["slow429@svc.test"]);
		await vi.advanceTimersByTimeAsync(101);
		expect((await b).success).toBe(true);
		expect(calls.map((c) => [c.key, c.at])).toEqual([
			["slow429@svc.test", 0],
			["b@svc.test", 5_100],
		]);
		await client.close();
	});

	it("sends nothing in the same tick the 429 lands", async () => {
		const { client, calls } = setup(partitionQueue);
		void client.get(url("svc.test", "slow429")).toPromise();
		void client.get(url("svc.test", "b")).toPromise();
		await vi.advanceTimersByTimeAsync(100);
		await vi.advanceTimersByTimeAsync(0);
		expect(calls).toHaveLength(1);
		await client.close();
	});

	it("frees the global permit of a bounced attempt so another partition runs", async () => {
		const { client, calls } = setup({ concurrency: 1 });
		void client.get(url("x.test", "slow429")).toPromise();
		const b = client.get(url("x.test", "b")).toPromise();
		const y = client.get(url("y.test", "y")).toPromise();
		await vi.advanceTimersByTimeAsync(100);
		expect((await y).success).toBe(true);
		expect(calls.map((c) => [c.key, c.at])).toEqual([
			["slow429@x.test", 0],
			["y@y.test", 100],
		]);
		await vi.advanceTimersByTimeAsync(5_000);
		expect((await b).success).toBe(true);
		expect(calls.at(-1)).toEqual({ key: "b@x.test", at: 5_100 });
		await client.close();
	});

	it("cancels a bounced attempt that is re-waiting, holding nothing", async () => {
		const { client, calls } = setup({ ...partitionQueue, concurrency: 1 });
		void client.get(url("svc.test", "slow429")).toPromise();
		const b = client.get(url("svc.test", "b"));
		const events: string[] = [];
		client.on("cancelled", () => events.push("cancelled"));
		client.on("failure", () => events.push("failure"));
		await vi.advanceTimersByTimeAsync(1_000);
		b.cancel();
		const result = await b.toPromise();
		expect(!result.success && result.error).toBeInstanceOf(CancelledError);
		await vi.advanceTimersByTimeAsync(10_000);
		expect(calls.map((c) => c.key)).toEqual(["slow429@svc.test"]);
		expect(client.partitions()[0]?.running).toBe(0);
		expect(events).toEqual(["failure", "cancelled"]);
		await client.close();
	});

	it("doesn't count a bounce as an attempt, and counts its wait as queued", async () => {
		const { client, calls } = setup({
			...partitionQueue,
			retry: { maxRetries: 1, backoff: { baseDelayMs: 0, maxDelayMs: 0, jitter: false } },
		});
		const done: Array<{ attempts: number; queuedMs: number }> = [];
		client.on("success", (e) => e.url.includes("flaky") && done.push({ attempts: e.attempts, queuedMs: e.queuedMs }));
		const retries: number[] = [];
		client.on("retry", (e) => e.url.includes("flaky") && retries.push(e.attempt));
		void client.get(url("svc.test", "flaky")).toPromise();
		void client.get(url("svc.test", "slow429")).toPromise();
		await vi.advanceTimersByTimeAsync(10_000);
		const flaky = calls.filter((c) => c.key === "flaky@svc.test");
		expect(flaky).toHaveLength(2);
		// The retry took the slot right as the 429 landed, bounced, and went at 5.1 s.
		expect(flaky[1]?.at).toBe(5_100);
		expect(retries).toEqual([0]);
		expect(done).toHaveLength(1);
		expect(done[0]?.attempts).toBe(2);
		expect(done[0]?.queuedMs).toBeGreaterThanOrEqual(5_000);
		await client.close();
	});

	it("still records the pause when a user isFailure throws on the 429", async () => {
		const { client, calls } = setup({
			circuitBreaker: {
				enabled: true,
				isFailure: () => {
					throw new Error("boom");
				},
			},
		});
		const first = client.get(url("svc.test", "slow429")).toPromise();
		await vi.advanceTimersByTimeAsync(100);
		await first;
		expect(client.partitions()[0]?.pausedUntil).toBe(5_100);
		const next = client.get(url("svc.test", "b")).toPromise();
		await vi.advanceTimersByTimeAsync(4_999);
		expect(calls).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(1);
		await next;
		await client.close();
	});
});

describe("waiters through an extended pause", () => {
	beforeEach(() => {
		vi.useFakeTimers({ now: 0 });
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	function arrive(bulkhead: Bulkhead, sentAt: number[]) {
		return bulkhead.takeToken()?.then(() => sentAt.push(Date.now()));
	}

	it("sends every waiter after the new end, at least 1/rate apart, when the pause is extended", async () => {
		const bulkhead = new Bulkhead("a", { pauseOnRetryAfter: {}, rateLimit: { tokensPerSec: 1, burst: 1 } });
		bulkhead.notePushback(pushback(429, 2_000));
		const sentAt: number[] = [];
		const waits = [0, 1, 2].map(() => arrive(bulkhead, sentAt));
		await vi.advanceTimersByTimeAsync(1_500);
		bulkhead.notePushback(pushback(429, 2_000)); // now ends at 3_500
		await vi.advanceTimersByTimeAsync(10_000);
		await Promise.all(waits);
		expect(sentAt).toHaveLength(3);
		for (const t of sentAt) expect(t).toBeGreaterThanOrEqual(3_500);
		for (let i = 1; i < sentAt.length; i++) expect(sentAt[i]! - sentAt[i - 1]!).toBeGreaterThanOrEqual(1_000);
	});

	it("keeps a waiter reserved before the pause ahead of one that arrives during it", async () => {
		const bulkhead = new Bulkhead("a", { pauseOnRetryAfter: {}, rateLimit: { tokensPerSec: 1, burst: 1 } });
		expect(bulkhead.takeToken()).toBeUndefined(); // drains the bucket
		const sentAt: number[] = [];
		const w1 = arrive(bulkhead, sentAt); // reserved at 0, due at 1_000
		await vi.advanceTimersByTimeAsync(500);
		bulkhead.notePushback(pushback(429, 3_000)); // ends at 3_500
		await vi.advanceTimersByTimeAsync(500);
		const w2 = arrive(bulkhead, sentAt); // arrives at 1_000, mid-pause
		await vi.advanceTimersByTimeAsync(10_000);
		await Promise.all([w1, w2]);
		expect(sentAt).toEqual([4_000, 5_000]);
	});

	it("leaves no tokens at the pause's end when a pre-pause reserver aborts mid-pause", async () => {
		const bulkhead = new Bulkhead("a", { pauseOnRetryAfter: {}, rateLimit: { tokensPerSec: 1, burst: 1 } });
		expect(bulkhead.takeToken()).toBeUndefined();
		const controller = new AbortController();
		const doomed = bulkhead.takeToken(controller.signal)!;
		await vi.advanceTimersByTimeAsync(500);
		bulkhead.notePushback(pushback(429, 3_000)); // ends at 3_500
		await vi.advanceTimersByTimeAsync(500);
		controller.abort();
		await expect(doomed).rejects.toBeInstanceOf(CancelledError);
		vi.setSystemTime(3_500);
		expect(bulkhead.tokensAvailable).toBe(0);
		const sentAt: number[] = [];
		const waits = [arrive(bulkhead, sentAt), arrive(bulkhead, sentAt)];
		await vi.advanceTimersByTimeAsync(5_000);
		await Promise.all(waits);
		expect(sentAt[1]! - sentAt[0]!).toBeGreaterThanOrEqual(1_000);
		expect(sentAt[0]! - 3_500).toBeGreaterThanOrEqual(1_000);
	});
});
