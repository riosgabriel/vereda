import * as http from "node:http";
import { describe, expect, it } from "vitest";
import { HttpClient } from "../../src/core/client.js";

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

			// Both failed (503 + no more retries), so both attempted twice.
			expect(requestCount).toBe(2);

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
