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

describe("Partition retry/timeout override (5.6)", () => {
	it("partition retry.maxRetries: 0 overrides global 3", async () => {
		let requestCount = 0;

		const { url, host, close } = await createServer((_req, res) => {
			requestCount++;
			res.writeHead(503, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "unavailable" }));
		});

		try {
			const client = HttpClient.create({
				retry: {
					maxRetries: 3,
					retryOnStatus: [503],
					backoff: { baseDelayMs: 10, jitter: false },
				},
				partitions: {
					[host]: { retry: { maxRetries: 0 } },
				},
			});

			await client.get(`${url}/`).toPromise();

			// Only 1 attempt (no retries) because partition overrides to 0.
			expect(requestCount).toBe(1);

			await client.close();
		} finally {
			await close();
		}
	});

	it("request-level retry overrides partition", async () => {
		let requestCount = 0;

		const { url, host, close } = await createServer((_req, res) => {
			requestCount++;
			res.writeHead(503, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "unavailable" }));
		});

		try {
			const client = HttpClient.create({
				retry: {
					maxRetries: 3,
					retryOnStatus: [503],
					backoff: { baseDelayMs: 10, jitter: false },
				},
				partitions: {
					[host]: { retry: { maxRetries: 1 } },
				},
			});

			// Request-level: 0 retries — overrides both global and partition.
			await client.get(`${url}/`, { retry: { maxRetries: 0 } }).toPromise();

			expect(requestCount).toBe(1);

			await client.close();
		} finally {
			await close();
		}
	});

	it("request-level retry overrides partition (2 retries)", async () => {
		let requestCount = 0;

		const { url, host, close } = await createServer((_req, res) => {
			requestCount++;
			res.writeHead(503, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "unavailable" }));
		});

		try {
			const client = HttpClient.create({
				retry: {
					maxRetries: 3,
					retryOnStatus: [503],
					backoff: { baseDelayMs: 10, jitter: false },
				},
				partitions: {
					[host]: { retry: { maxRetries: 1 } },
				},
			});

			// Request-level: 2 retries — overrides partition (1) and global (3).
			await client
				.get(`${url}/`, {
					retry: { maxRetries: 2, backoff: { baseDelayMs: 10, jitter: false } },
				})
				.toPromise();

			// 1 initial + 2 retries = 3 total attempts.
			expect(requestCount).toBe(3);

			await client.close();
		} finally {
			await close();
		}
	});
});
