import { describe, expect, it } from "vitest";
import { HttpClient } from "../../src/core/client.ts";
import { CancelledError } from "../../src/core/errors.ts";
import { Bulkhead } from "../../src/queue/bulkhead.ts";
import { Semaphore } from "../../src/queue/semaphore.ts";

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("Semaphore — abort-aware waiters (B9)", () => {
	it("an aborted waiter leaves the queue and rejects with CancelledError", async () => {
		const sem = new Semaphore(1, 1);
		const release = await sem.acquire();
		const ac = new AbortController();
		const waiting = sem.acquire(ac.signal);
		expect(sem.queueLength).toBe(1);

		ac.abort();
		await expect(waiting).rejects.toBeInstanceOf(CancelledError);
		expect(sem.queueLength).toBe(0);

		// Its queue place is free again, and the permit isn't leaked.
		const next = sem.acquire();
		release();
		const releaseNext = await next;
		releaseNext();
		expect(sem.availablePermits).toBe(1);
	});

	it("an already-aborted signal rejects without taking a permit", async () => {
		const sem = new Semaphore(1);
		await expect(sem.acquire(AbortSignal.abort())).rejects.toBeInstanceOf(CancelledError);
		expect(sem.availablePermits).toBe(1);
	});

	it("release() is idempotent", async () => {
		const sem = new Semaphore(1);
		const release = await sem.acquire();
		release();
		release();
		expect(sem.availablePermits).toBe(1);
	});
});

describe("Bulkhead — abort-aware waiters (B9)", () => {
	it("an aborted waiter leaves the partition queue without running its task", async () => {
		const bh = new Bulkhead("p", { concurrency: 1, maxQueueSize: 1 });
		let finish!: () => void;
		const running = bh.run(() => new Promise<void>((r) => (finish = r)));
		const ac = new AbortController();
		let ran = false;
		const waiting = bh.run(
			async () => {
				ran = true;
			},
			undefined,
			undefined,
			ac.signal,
		);
		expect(bh.queueSize).toBe(1);

		ac.abort();
		await expect(waiting).rejects.toBeInstanceOf(CancelledError);
		expect(bh.queueSize).toBe(0);

		finish();
		await running;
		expect(ran).toBe(false);
		expect(bh.runningCount).toBe(0);
	});

	it("aborting while waiting for the global permit frees the partition slot", async () => {
		const sem = new Semaphore(1);
		const holdGlobal = await sem.acquire();
		const bh = new Bulkhead("p", { concurrency: 1 });
		const ac = new AbortController();
		const waiting = bh.run(async () => "ran", sem, undefined, ac.signal);
		await tick();
		expect(bh.runningCount).toBe(1); // slot granted, now waiting on the semaphore

		ac.abort();
		await expect(waiting).rejects.toBeInstanceOf(CancelledError);
		expect(bh.runningCount).toBe(0);
		expect(sem.queueLength).toBe(0);
		holdGlobal();
	});
});

describe("HttpClient — cancelled tickets don't hold queue capacity (B9)", () => {
	const slow: typeof globalThis.fetch = () =>
		new Promise((resolve) => setTimeout(() => resolve(new Response("{}", { status: 200 })), 80));

	it("a ticket cancelled while waiting for a global permit frees its queue place", async () => {
		const client = HttpClient.create({ timeout: { attemptMs: 1_000 }, concurrency: 1, maxQueueSize: 1, fetch: slow });
		const events: string[] = [];
		client.on("cancelled", () => events.push("cancelled"));

		const running = client.get("http://svc.test/a");
		const doomed = client.get("http://svc.test/b");
		await tick();
		doomed.cancel();
		await tick();

		const result = await client.get("http://svc.test/c").toPromise();
		expect(result.success).toBe(true);
		expect((await running.toPromise()).success).toBe(true);
		expect(events).toEqual(["cancelled"]);
	});

	it("a deadline that fires while waiting in the queue resolves as a deadline failure", async () => {
		const client = HttpClient.create({ timeout: { attemptMs: 1_000 }, concurrency: 1, fetch: slow });
		const events: string[] = [];
		for (const e of ["success", "failure", "cancelled"] as const) client.on(e, () => events.push(e));

		const running = client.get("http://svc.test/a");
		const result = await client.get("http://svc.test/b", { timeout: { totalMs: 20 } }).toPromise();
		expect(result.success === false && result.error.kind).toBe("deadline");
		await running.toPromise();
		expect(events).toEqual(["failure", "success"]);
	});
});
