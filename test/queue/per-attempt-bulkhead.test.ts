import * as http from "node:http";
import { describe, expect, it } from "vitest";
import { HttpClient } from "../../src/core/client.js";
import { Bulkhead } from "../../src/queue/bulkhead.js";

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

describe("Per-attempt bulkhead scheduling (5.1)", () => {
	it("releases the slot between retries so other tickets are not blocked", async () => {
		// D4: Each attempt is a bulkhead task. The retry loop lives outside the
		// bulkhead: sleep(delay) → bulkhead.run(() => execute(…)) → evaluate.
		// With concurrency: 1 two failing tickets with baseDelayMs: 300 should
		// both complete — at t≈150ms running === 0 (both sleeping between retries).

		let requestCount = 0;
		const { url, close } = await createServer((_req, res) => {
			requestCount++;
			res.statusCode = 503;
			res.end("service unavailable");
		});

		try {
			const client = HttpClient.create({
				retry: {
					maxRetries: 2,
					backoff: { baseDelayMs: 300, maxDelayMs: 300, jitter: false },
				},
				// Single partition with concurrency 1
				partitions: { "127.0.0.1": { concurrency: 1 } },
			});

			const t0 = Date.now();

			// Fire two requests concurrently — both will fail and retry
			const [result1, result2] = await Promise.all([client.get(url).toPromise(), client.get(url).toPromise()]);

			const elapsed = Date.now() - t0;

			// Both should fail (server always returns 503)
			expect(result1.success).toBe(false);
			expect(result2.success).toBe(false);

			// Each request: 1 first attempt + 2 retries = 3 server hits
			// Total: 6 server hits
			expect(requestCount).toBe(6);

			// With per-attempt scheduling, both tickets retry in parallel.
			// Without it (old behavior: one slot held for entire retry loop),
			// the second ticket would be blocked until the first finishes,
			// doubling the total time. With per-attempt, total time should be
			// ~900ms (2 retries × 300ms backoff), not ~1800ms.
			// Allow generous margin for CI.
			expect(elapsed).toBeLessThan(1500);

			await client.close();
		} finally {
			await close();
		}
	});

	it("bulkhead.run acquires and releases a slot per call", async () => {
		const bh = new Bulkhead("test", { concurrency: 1 });

		const result = await bh.run(async () => 42);
		expect(result).toBe(42);

		// Slot should be released — running count back to 0
		expect(bh.runningCount).toBe(0);
	});

	it("bulkhead.run rejects with QueueFullError when queue is at capacity", async () => {
		const bh = new Bulkhead("test", { concurrency: 1, maxQueueSize: 0 });

		// Fill the only running slot so the next run() must queue
		// `!`: the Promise executor runs synchronously, so this is assigned before use.
		let release!: () => void;
		const blocker = new Promise<void>((r) => {
			release = r;
		});
		const p1 = bh.run(async () => {
			await blocker;
		});

		// Now running = 1 and _waitQueue can hold 0 → should reject
		await expect(bh.run(async () => "second")).rejects.toThrow("full");

		// Clean up
		release();
		await p1;
	});
});
