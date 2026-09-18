import { describe, expect, it } from "vitest";
import { Bulkhead, BulkheadRegistry } from "../../src/queue/bulkhead.js";
import { Semaphore } from "../../src/queue/semaphore.js";

describe("Bulkhead", () => {
	it("runs tasks up to concurrency limit", async () => {
		const bh = new Bulkhead("test", { concurrency: 2 });
		const running: number[] = [];
		let maxConcurrent = 0;

		const makeTask = (id: number, delay: number) => async () => {
			running.push(id);
			maxConcurrent = Math.max(maxConcurrent, running.length);
			await new Promise((r) => setTimeout(r, delay));
			running.splice(running.indexOf(id), 1);
		};

		await Promise.all([bh.run(makeTask(1, 30)), bh.run(makeTask(2, 30)), bh.run(makeTask(3, 10))]);

		expect(maxConcurrent).toBeLessThanOrEqual(2);
	});

	it("rejects tasks when queue is full", async () => {
		const bh = new Bulkhead("test", { concurrency: 1, maxQueueSize: 1 });
		const slow = () => new Promise<void>((r) => setTimeout(r, 100));

		// First fills the runner
		void bh.run(slow);
		// Second fills the wait queue
		void bh.run(slow);
		// Third should be rejected
		await expect(bh.run(slow)).rejects.toThrow("full");
	});

	it("reports running count", async () => {
		const bh = new Bulkhead("test", { concurrency: 1 });
		const slow = () => new Promise<void>((r) => setTimeout(r, 50));

		const p1 = bh.run(slow);
		void bh.run(slow);

		expect(bh.runningCount).toBe(1);

		await p1;
	});

	it("reports queue size for callers waiting on run() (regression: was reading the dead schedule() queue)", async () => {
		const bh = new Bulkhead("test", { concurrency: 1 });
		const slow = () => new Promise<void>((r) => setTimeout(r, 50));

		const p1 = bh.run(slow);
		const p2 = bh.run(slow);

		expect(bh.queueSize).toBe(1);

		await Promise.all([p1, p2]);
		expect(bh.queueSize).toBe(0);
	});

	it("invokes onDequeue with the real elapsed wait, not immediately on run()", async () => {
		const bh = new Bulkhead("test", { concurrency: 1 });
		const slow = (ms: number) => () => new Promise<void>((r) => setTimeout(r, ms));

		let firstQueuedMs = -1;
		let secondQueuedMs = -1;

		const p1 = bh.run(slow(50), undefined, (ms) => {
			firstQueuedMs = ms;
		});
		const p2 = bh.run(slow(10), undefined, (ms) => {
			secondQueuedMs = ms;
		});

		await Promise.all([p1, p2]);

		expect(firstQueuedMs).toBeLessThan(20); // slot was free — ran immediately (allow scheduling jitter)
		expect(secondQueuedMs).toBeGreaterThanOrEqual(30); // waited for the first task's slot
	});

	it("does not leak a running slot when the global semaphore rejects (regression)", async () => {
		// Before the fix, execute() incremented `running` and then handed off to
		// semaphore.acquire(), whose rejection branch called `reject` directly —
		// skipping the decrement/drain that only runTask()'s own rejection path
		// performed. A rejected semaphore acquire left the partition permanently
		// short one slot.
		const bh = new Bulkhead("test", { concurrency: 1 });
		const fullSemaphore = new Semaphore(0, 0); // no permits, no room to wait — rejects immediately

		await expect(bh.run(() => Promise.resolve(), fullSemaphore)).rejects.toThrow("full");
		expect(bh.runningCount).toBe(0); // the partition slot must be released, not leaked

		// A leaked slot would make this hang forever (concurrency: 1, already "running").
		let ran = false;
		await bh.run(async () => {
			ran = true;
		});
		expect(ran).toBe(true);
	});

	it("releases the semaphore permit before draining the next waiter (regression: was ordered the other way, spuriously rejecting a waiter with a permit about to free)", async () => {
		// Before the fix, `.finally(release)` ran the semaphore release AFTER
		// _releaseSlot() had already synchronously drained the bulkhead's own
		// wait queue — so the next waiter's semaphore.acquire() call could see
		// zero permits available (the just-finished task's permit not freed
		// yet) and reject with QueueFullError even though one was about to
		// free. A zero-room semaphore (1 permit, 0 queue) makes that rejection
		// immediate and deterministic if the ordering regresses.
		const bh = new Bulkhead("test", { concurrency: 1 });
		const sem = new Semaphore(1, 0);

		const p1 = bh.run(() => Promise.resolve("a"), sem);
		const p2 = bh.run(() => Promise.resolve("b"), sem);

		await expect(p1).resolves.toBe("a");
		await expect(p2).resolves.toBe("b");
	});
});

describe("BulkheadRegistry", () => {
	it("creates separate bulkheads per partition", () => {
		const registry = new BulkheadRegistry({ concurrency: 5 });
		const a = registry.get("payments");
		const b = registry.get("notifications");
		expect(a).not.toBe(b);
	});

	it("returns the same bulkhead for the same partition", () => {
		const registry = new BulkheadRegistry();
		expect(registry.get("payments")).toBe(registry.get("payments"));
	});

	it("applies partition-specific config", () => {
		const registry = new BulkheadRegistry({ concurrency: 10 }, { payments: { concurrency: 2 } });
		const payments = registry.get("payments");
		expect((payments as unknown as { concurrency: number }).concurrency).toBe(2);
	});
});
