import * as http from "node:http";
import { describe, expect, it } from "vitest";
import { HttpClient } from "../../src/core/client.ts";
import { CircuitOpenError } from "../../src/core/errors.ts";

function createServer(
	handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<{ url: string; host: string; close: () => Promise<void> }> {
	return new Promise((resolve) => {
		const server = http.createServer(handler);
		server.listen(0, "127.0.0.1", () => {
			const addr = server.address()!;
			const port = typeof addr === "string" ? 0 : addr.port;
			resolve({
				url: `http://127.0.0.1:${port}`,
				host: `127.0.0.1:${port}`,
				close: () => new Promise<void>((r) => server.close(() => r())),
			});
		});
	});
}

describe("Partition snapshots (5.4)", () => {
	it("snapshot reflects a queued ticket, then returns to zeros", async () => {
		// First attempts bypass the partition bulkhead (D4), so we need retries
		// to observe running/queued counts in the snapshot.  The server returns
		// 503 so requests fail and enter the retry loop via bulkhead.run().
		let requestCount = 0;

		const { url, host, close } = await createServer((_req, res) => {
			requestCount++;
			res.statusCode = 503;
			res.end("error");
		});

		try {
			const client = HttpClient.create({
				baseUrl: url,
				timeout: { attemptMs: 5_000 },
				concurrency: 10,
				retry: {
					maxRetries: 1,
					backoff: { baseDelayMs: 200, jitter: false },
				},
				partitions: {
					[host]: { concurrency: 1 },
				},
			});

			// Fire two requests simultaneously — both fail on first attempt,
			// then enter the retry loop. With partition concurrency: 1, only
			// one retry can run at a time.
			const t1 = client.get("/a");
			const t2 = client.get("/b");

			// Wait for both to resolve.
			await Promise.all([t1.toPromise(), t2.toPromise()]);

			// Both failed (503 + no more retries), so both attempted twice — four
			// server hits. (This once read 2: retries used to fetch the bare
			// relative path instead of baseUrl + path, and never reached the
			// server, B16.)
			expect(requestCount).toBe(4);

			// After completion, snapshot should return to zeros.
			const snapshots = client.partitions();
			expect(snapshots.length).toBeGreaterThanOrEqual(1);
			const snapshot = snapshots.find((s) => s.name === host);
			expect(snapshot).toBeDefined();
			expect(snapshot?.running).toBe(0);
			expect(snapshot?.queued).toBe(0);

			await client.close();
		} finally {
			await close();
		}
	});

	it("snapshot shows concurrency and maxQueueSize limits", async () => {
		const { url, host, close } = await createServer((_req, res) => {
			res.statusCode = 200;
			res.end("ok");
		});

		try {
			const client = HttpClient.create({
				baseUrl: url,
				timeout: { attemptMs: 5_000 },
				retry: { maxRetries: 0 },
				partitions: {
					[host]: { concurrency: 3, maxQueueSize: 5 },
				},
			});

			await client.get("/").toPromise();

			const snapshots = client.partitions();
			expect(snapshots).toHaveLength(1);
			expect(snapshots[0].name).toBe(host);
			expect(snapshots[0].concurrency).toBe(3);
			expect(snapshots[0].maxQueueSize).toBe(5);

			await client.close();
		} finally {
			await close();
		}
	});
});

describe("Circuit breaker integration", () => {
	it("stays inert (never short-circuits) when circuitBreaker is not configured", async () => {
		let requestCount = 0;

		const { url, close } = await createServer((_req, res) => {
			requestCount++;
			res.statusCode = 503;
			res.end("error");
		});

		try {
			const client = HttpClient.create({
				baseUrl: url,
				timeout: { attemptMs: 5_000 },
				retry: { maxRetries: 0, retryOnStatus: [503] },
			});

			// No circuitBreaker config anywhere — the breaker must be fully inert
			// (opt-in feature), so repeated failures never produce CircuitOpenError.
			const r1 = await client.get("/a").toPromise();
			const r2 = await client.get("/b").toPromise();

			expect(requestCount).toBe(2);
			expect(r1.success).toBe(false);
			expect(r2.success).toBe(false);
			if (!r1.success) expect(r1.error).not.toBeInstanceOf(CircuitOpenError);
			if (!r2.success) expect(r2.error).not.toBeInstanceOf(CircuitOpenError);

			await client.close();
		} finally {
			await close();
		}
	});

	it("opens the circuit after consecutive failures and short-circuits with CircuitOpenError", async () => {
		let requestCount = 0;

		const { url, host, close } = await createServer((_req, res) => {
			requestCount++;
			res.statusCode = 503;
			res.end("error");
		});

		try {
			const client = HttpClient.create({
				baseUrl: url,
				timeout: { attemptMs: 5_000 },
				retry: { maxRetries: 0, retryOnStatus: [503] },
				partitions: {
					[host]: { circuitBreaker: { enabled: true, failureThreshold: 1 } },
				},
			});

			// First request fails and should trip the breaker (failureThreshold: 1).
			const r1 = await client.get("/a").toPromise();
			expect(r1.success).toBe(false);
			expect(requestCount).toBe(1);

			// Second request should be short-circuited by the now-open breaker,
			// never reaching the server.
			const r2 = await client.get("/b").toPromise();
			expect(requestCount).toBe(1);
			expect(r2.success).toBe(false);
			if (!r2.success) expect(r2.error).toBeInstanceOf(CircuitOpenError);

			await client.close();
		} finally {
			await close();
		}
	});
});
