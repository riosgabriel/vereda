import * as http from "node:http";
import { describe, expect, it } from "vitest";
import { QueueFullError } from "../../src/core/errors.js";
import { Semaphore } from "../../src/queue/semaphore.js";

function createServer(
	handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<{ url: string; close: () => Promise<void> }> {
	return new Promise((resolve) => {
		const server = http.createServer(handler);
		server.listen(0, "127.0.0.1", () => {
			const addr = server.address()!;
			const port = typeof addr === "string" ? 0 : addr.port;
			resolve({
				url: `http://127.0.0.1:${port}`,
				close: () => new Promise<void>((r) => server.close(() => r())),
			});
		});
	});
}

describe("Global semaphore (5.2)", () => {
	it("limits total concurrent executions across partitions", async () => {
		// D1: concurrency (global, default 50) is a semaphore acquired inside
		// Bulkhead.run after the partition slot.
		// Acceptance: concurrency: 2, three partitions each with concurrency: 5,
		// 6 slow failing requests → never more than 2 in flight.

		let maxConcurrent = 0;
		let currentConcurrent = 0;

		const { url, close } = await createServer((_req, res) => {
			currentConcurrent++;
			maxConcurrent = Math.max(maxConcurrent, currentConcurrent);
			// Slow response to keep requests in-flight
			setTimeout(() => {
				currentConcurrent--;
				res.statusCode = 503;
				res.end("unavailable");
			}, 100);
		});

		try {
			// Import HttpClient here to avoid circular dependency issues
			const { HttpClient } = await import("../../src/core/client.js");

			const client = HttpClient.create({
				baseUrl: url,
				timeout: { attemptMs: 5_000 },
				concurrency: 2, // Global semaphore: max 2 across all partitions
				retry: {
					maxRetries: 0, // No retries — just fire once
				},
				partitions: {
					"127.0.0.1": { concurrency: 5 }, // Per-partition allows 5
				},
			});

			// Fire 6 requests across 3 different partitions
			await Promise.all([
				client.get("/a", { partition: "p1" }).toPromise(),
				client.get("/b", { partition: "p1" }).toPromise(),
				client.get("/c", { partition: "p2" }).toPromise(),
				client.get("/d", { partition: "p2" }).toPromise(),
				client.get("/e", { partition: "p3" }).toPromise(),
				client.get("/f", { partition: "p3" }).toPromise(),
			]);

			// Never more than 2 concurrent requests despite partitions allowing 5 each
			expect(maxConcurrent).toBeLessThanOrEqual(2);

			await client.close();
		} finally {
			await close();
		}
	});

	it("Semaphore acquires and releases permits", async () => {
		const sem = new Semaphore(2);

		const release1 = await sem.acquire();
		const release2 = await sem.acquire();

		// Both permits used — third should wait
		let acquired = false;
		const p3 = sem.acquire().then((release) => {
			acquired = true;
			return release;
		});

		// Give microtask queue time to process
		await new Promise((r) => setTimeout(r, 10));
		expect(acquired).toBe(false); // Still waiting

		// Release one permit — third should now acquire
		release1();
		const release3 = await p3;
		expect(acquired).toBe(true);

		// Clean up
		release2();
		release3();
	});

	it("exposes queueLength and availablePermits for gauge reporting", async () => {
		const sem = new Semaphore(1);
		expect(sem.availablePermits).toBe(1);
		expect(sem.queueLength).toBe(0);

		const release1 = await sem.acquire();
		expect(sem.availablePermits).toBe(0);

		let acquired = false;
		const p2 = sem.acquire().then((release) => {
			acquired = true;
			return release;
		});

		await new Promise((r) => setTimeout(r, 10));
		expect(sem.queueLength).toBe(1);
		expect(acquired).toBe(false);

		release1();
		const release2 = await p2;
		expect(sem.queueLength).toBe(0);
		expect(sem.availablePermits).toBe(0); // release2's permit still held

		release2();
		expect(sem.availablePermits).toBe(1);
	});

	it("Semaphore rejects when wait queue is full", async () => {
		const sem = new Semaphore(1, 0); // 1 permit, 0 wait queue

		const release1 = await sem.acquire();

		// Permit taken, wait queue full → should reject
		await expect(sem.acquire()).rejects.toThrow("full");

		release1();
	});

	it("surfaces QueueFullError (not a generic NetworkError) when a first attempt overflows the global queue", async () => {
		// Reproduces the bug: _fireFirstAttempt's global semaphore.acquire()
		// rejects with QueueFullError, but request()'s outer .catch() used to
		// unconditionally demote it to NetworkError, discarding `kind` and the
		// partition/queueSize/maxQueueSize fields into an inaccessible `.cause`.
		// concurrency: 1 + maxQueueSize: 0 means the second simultaneous first
		// attempt has nowhere to queue and must reject immediately.

		const { url, close } = await createServer((_req, res) => {
			// Slow response so the first request holds its permit while the
			// second request's semaphore.acquire() call overflows the queue.
			setTimeout(() => {
				res.statusCode = 200;
				res.end("ok");
			}, 100);
		});

		try {
			const { HttpClient } = await import("../../src/core/client.js");

			const client = HttpClient.create({
				baseUrl: url,
				timeout: { attemptMs: 5_000 },
				concurrency: 1, // Global semaphore: only 1 permit
				maxQueueSize: 0, // No room to wait — overflow rejects immediately
				retry: {
					maxRetries: 0, // First-attempt path only, no retry loop involved
				},
			});

			const [first, second] = await Promise.all([client.get("/a").toPromise(), client.get("/b").toPromise()]);

			// The first request should succeed (it took the only permit).
			expect(first.success).toBe(true);

			// The second should fail with the queue-full classification intact.
			expect(second.success).toBe(false);
			if (!second.success) {
				expect(second.error).toBeInstanceOf(QueueFullError);
				expect(second.error.kind).toBe("queue_full");
			}

			await client.close();
		} finally {
			await close();
		}
	});
});
