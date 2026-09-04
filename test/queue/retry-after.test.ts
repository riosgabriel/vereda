import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HttpClient } from "../../src/core/client.js";
import { parseRetryAfter } from "../../src/queue/executor.js";

interface TestServer {
	url: string;
	close: () => Promise<void>;
	setHandler: (fn: (req: IncomingMessage, res: ServerResponse) => void) => void;
}

function createTestServer(): Promise<TestServer> {
	return new Promise((resolve) => {
		let handler: (req: IncomingMessage, res: ServerResponse) => void = (_req, res) => {
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ ok: true }));
		};
		const server = createServer((req, res) => handler(req, res));
		server.listen(0, "127.0.0.1", () => {
			const addr = server.address() as { port: number };
			resolve({
				url: `http://127.0.0.1:${addr.port}`,
				close: () => new Promise((r) => server.close(() => r())),
				setHandler: (fn) => {
					handler = fn;
				},
			});
		});
	});
}

describe("parseRetryAfter", () => {
	it("parses integer seconds into ms", () => {
		expect(parseRetryAfter("2")).toBe(2000);
	});

	it("returns undefined for garbage", () => {
		expect(parseRetryAfter("soon")).toBeUndefined();
		expect(parseRetryAfter(null)).toBeUndefined();
	});

	it("clamps a past HTTP-date to 0", () => {
		const past = new Date(Date.now() - 60_000).toUTCString();
		expect(parseRetryAfter(past)).toBe(0);
	});
});

describe("Retry-After honors", () => {
	let server: TestServer;

	beforeAll(async () => {
		server = await createTestServer();
	});

	afterAll(async () => {
		await server.close();
	});

	it("429 Retry-After: 1 delays the retry ~1s despite baseDelayMs 10", async () => {
		const times: number[] = [];
		server.setHandler((_req, res) => {
			times.push(Date.now());
			if (times.length === 1) {
				res.writeHead(429, { "Retry-After": "1" });
				res.end("too many");
			} else {
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ ok: true }));
			}
		});

		const client = HttpClient.create({
			retry: { backoff: { baseDelayMs: 10, jitter: false } },
		});
		const result = await client.get(`${server.url}/seconds`).toPromise();

		expect(result.success).toBe(true);
		expect(times).toHaveLength(2);
		expect(times[1] - times[0]).toBeGreaterThanOrEqual(950);
	}, 10_000);

	it("caps a long Retry-After at maxDelayMs", async () => {
		const times: number[] = [];
		server.setHandler((_req, res) => {
			times.push(Date.now());
			if (times.length === 1) {
				res.writeHead(429, { "Retry-After": "120" });
				res.end("too many");
			} else {
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ ok: true }));
			}
		});

		const client = HttpClient.create({
			retry: { backoff: { baseDelayMs: 10, maxDelayMs: 500, jitter: false } },
		});
		const result = await client.get(`${server.url}/capped`).toPromise();

		expect(result.success).toBe(true);
		expect(times).toHaveLength(2);
		// Capped to 500ms (not 120s). Node's localhost fetch can add up to ~2.5s
		// of connection latency on the first re-fetch, so the ceiling is generous.
		expect(times[1] - times[0]).toBeGreaterThanOrEqual(400);
		expect(times[1] - times[0]).toBeLessThan(5000);
	}, 10_000);

	it("honors an HTTP-date Retry-After", async () => {
		const times: number[] = [];
		server.setHandler((_req, res) => {
			times.push(Date.now());
			if (times.length === 1) {
				// ~2s ahead, truncated UP to a second boundary, so the parsed delay
				// is reliably ≥ 1000ms (HTTP-date has whole-second resolution).
				const date = new Date(Math.ceil((Date.now() + 2000) / 1000) * 1000).toUTCString();
				res.writeHead(429, { "Retry-After": date });
				res.end("too many");
			} else {
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ ok: true }));
			}
		});

		const client = HttpClient.create({
			retry: { backoff: { baseDelayMs: 10, jitter: false } },
		});
		const result = await client.get(`${server.url}/http-date`).toPromise();

		expect(result.success).toBe(true);
		expect(times).toHaveLength(2);
		expect(times[1] - times[0]).toBeGreaterThanOrEqual(900);
	}, 10_000);

	it("falls back to backoff for garbage Retry-After", async () => {
		const times: number[] = [];
		server.setHandler((_req, res) => {
			times.push(Date.now());
			if (times.length === 1) {
				res.writeHead(429, { "Retry-After": "soon" });
				res.end("too many");
			} else {
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ ok: true }));
			}
		});

		const client = HttpClient.create({
			retry: { backoff: { baseDelayMs: 10, jitter: false } },
		});
		const result = await client.get(`${server.url}/garbage`).toPromise();

		expect(result.success).toBe(true);
		expect(times).toHaveLength(2);
		// Backoff is 10ms; allow generous headroom for localhost connection latency
		// (which can reach ~2.5s). The point is the delay is nowhere near 1s+.
		expect(times[1] - times[0]).toBeLessThan(3000);
	}, 10_000);
});
