import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HttpClient } from "../../src/core/client.js";
import type { LifecycleEventMap } from "../../src/core/types.js";

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

describe("Lifecycle events (6.1)", () => {
	let server: TestServer;

	beforeAll(async () => {
		server = await createTestServer();
	});

	afterAll(async () => {
		await server.close();
	});

	// -----------------------------------------------------------------------
	// Helpers
	// -----------------------------------------------------------------------

	function collectEvents(client: HttpClient) {
		const events: { name: string; data: unknown }[] = [];
		for (const name of ["request", "retry", "success", "failure", "cancelled"] as const) {
			client.on(name, (data) => events.push({ name, data }));
		}
		return events;
	}

	// -----------------------------------------------------------------------
	// request event — includes partition
	// -----------------------------------------------------------------------

	it("request event includes partition", async () => {
		const client = HttpClient.create();
		const events = collectEvents(client);

		server.setHandler((_req, res) => {
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end("{}");
		});

		await client.get(`${server.url}/test`).toPromise();

		const req = events.find((e) => e.name === "request");
		expect(req).toBeDefined();
		const data = req?.data as LifecycleEventMap["request"];
		expect(data.method).toBe("GET");
		expect(data.partition).toBeTruthy();
		expect(typeof data.partition).toBe("string");

		await client.close();
	});

	// -----------------------------------------------------------------------
	// success event — exactly one terminal event with correct shape
	// -----------------------------------------------------------------------

	it("success event has correct shape: attempts, durationMs, queuedMs, statusCode", async () => {
		const client = HttpClient.create({
			retry: { backoff: { baseDelayMs: 10, jitter: false } },
		});
		const events = collectEvents(client);

		server.setHandler((_req, res) => {
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end("{}");
		});

		await client.get(`${server.url}/ok`).toPromise();

		const successes = events.filter((e) => e.name === "success");
		expect(successes).toHaveLength(1);
		const data = successes[0].data as LifecycleEventMap["success"];
		expect(data.attempts).toBe(1);
		expect(data.durationMs).toBeGreaterThanOrEqual(0);
		expect(data.queuedMs).toBe(0);
		expect(data.statusCode).toBe(200);
		expect(data.url).toBe(`${server.url}/ok`);
		expect(typeof data.ticketId).toBe("string");

		// No failure or cancelled events for a success
		expect(events.filter((e) => e.name === "failure")).toHaveLength(0);
		expect(events.filter((e) => e.name === "cancelled")).toHaveLength(0);

		await client.close();
	});

	// -----------------------------------------------------------------------
	// failure event — terminal, includes timing
	// -----------------------------------------------------------------------

	it("failure event has correct shape: attempts, durationMs, queuedMs, error", async () => {
		const client = HttpClient.create({
			retry: {
				maxRetries: 0,
				backoff: { baseDelayMs: 10, jitter: false },
			},
		});
		const events = collectEvents(client);

		server.setHandler((_req, res) => {
			res.writeHead(500, { "Content-Type": "application/json" });
			res.end("{}");
		});

		await client.get(`${server.url}/fail`).toPromise();

		const failures = events.filter((e) => e.name === "failure");
		expect(failures).toHaveLength(1);
		const data = failures[0].data as LifecycleEventMap["failure"];
		expect(data.attempts).toBe(1);
		expect(data.durationMs).toBeGreaterThanOrEqual(0);
		expect(data.queuedMs).toBe(0);
		expect(data.error).toBeDefined();
		expect(typeof data.error.message).toBe("string");

		// No success or cancelled events for a failure
		expect(events.filter((e) => e.name === "success")).toHaveLength(0);
		expect(events.filter((e) => e.name === "cancelled")).toHaveLength(0);

		await client.close();
	});

	// -----------------------------------------------------------------------
	// cancelled event — exactly one terminal event
	// -----------------------------------------------------------------------

	it("cancelled event has correct shape: attempts, durationMs", async () => {
		const client = HttpClient.create({
			retry: { backoff: { baseDelayMs: 1000, jitter: false } },
		});
		const events = collectEvents(client);

		server.setHandler((_req, res) => {
			res.writeHead(503, { "Content-Type": "application/json" });
			res.end("{}");
		});

		const ticket = client.get(`${server.url}/slow`);
		// Cancel after a brief moment (while queued for retry)
		setTimeout(() => ticket.cancel(), 50);
		await ticket.toPromise();

		const cancelled = events.filter((e) => e.name === "cancelled");
		expect(cancelled).toHaveLength(1);
		const data = cancelled[0].data as LifecycleEventMap["cancelled"];
		expect(data.attempts).toBeGreaterThanOrEqual(1);
		expect(data.durationMs).toBeGreaterThanOrEqual(0);
		expect(typeof data.ticketId).toBe("string");

		// No success events for a cancelled ticket
		expect(events.filter((e) => e.name === "success")).toHaveLength(0);

		await client.close();
	});

	// -----------------------------------------------------------------------
	// Exactly one terminal event per ticket — success path
	// -----------------------------------------------------------------------

	it("emits exactly one terminal event (success) per ticket", async () => {
		const client = HttpClient.create();
		const events = collectEvents(client);

		server.setHandler((_req, res) => {
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end("{}");
		});

		await client.get(`${server.url}/a`).toPromise();
		await client.get(`${server.url}/b`).toPromise();

		const terminalEvents = events.filter((e) => e.name === "success" || e.name === "failure" || e.name === "cancelled");
		expect(terminalEvents).toHaveLength(2);
		expect(terminalEvents.every((e) => e.name === "success")).toBe(true);

		await client.close();
	});

	// -----------------------------------------------------------------------
	// Exactly one terminal event per ticket — failure path
	// -----------------------------------------------------------------------

	it("emits exactly one terminal event (failure) per ticket", async () => {
		const client = HttpClient.create({
			retry: {
				maxRetries: 0,
				backoff: { baseDelayMs: 10, jitter: false },
			},
		});
		const events = collectEvents(client);

		server.setHandler((_req, res) => {
			res.writeHead(500, { "Content-Type": "application/json" });
			res.end("{}");
		});

		await client.get(`${server.url}/a`).toPromise();
		await client.get(`${server.url}/b`).toPromise();

		const terminalEvents = events.filter((e) => e.name === "success" || e.name === "failure" || e.name === "cancelled");
		expect(terminalEvents).toHaveLength(2);
		expect(terminalEvents.every((e) => e.name === "failure")).toBe(true);

		await client.close();
	});

	// -----------------------------------------------------------------------
	// success after retry — attempts > 1, statusCode present
	// -----------------------------------------------------------------------

	it("success after retry has attempts > 1 and statusCode", async () => {
		let hits = 0;
		const client = HttpClient.create({
			retry: {
				maxRetries: 3,
				retryOnStatus: [503],
				backoff: { baseDelayMs: 10, jitter: false },
			},
		});
		const events = collectEvents(client);

		server.setHandler((_req, res) => {
			hits++;
			if (hits < 3) {
				res.writeHead(503, { "Content-Type": "application/json" });
				res.end("{}");
			} else {
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end("{}");
			}
		});

		await client.get(`${server.url}/retry-then-ok`).toPromise();

		const successes = events.filter((e) => e.name === "success");
		expect(successes).toHaveLength(1);
		const data = successes[0].data as LifecycleEventMap["success"];
		expect(data.attempts).toBe(3); // 2 failures + 1 success
		expect(data.statusCode).toBe(200);
		expect(data.durationMs).toBeGreaterThanOrEqual(0);
		expect(data.queuedMs).toBeGreaterThanOrEqual(0);

		// Should have retry events
		const retries = events.filter((e) => e.name === "retry");
		expect(retries.length).toBeGreaterThanOrEqual(1);

		await client.close();
	});

	// -----------------------------------------------------------------------
	// failure after exhausted retries — attempts = maxRetries + 1
	// -----------------------------------------------------------------------

	it("failure after exhausted retries has correct attempts count", async () => {
		const client = HttpClient.create({
			retry: {
				maxRetries: 2,
				retryOnStatus: [503],
				backoff: { baseDelayMs: 10, jitter: false },
			},
		});
		const events = collectEvents(client);

		server.setHandler((_req, res) => {
			res.writeHead(503, { "Content-Type": "application/json" });
			res.end("{}");
		});

		await client.get(`${server.url}/always-503`).toPromise();

		const failures = events.filter((e) => e.name === "failure");
		expect(failures).toHaveLength(1);
		const data = failures[0].data as LifecycleEventMap["failure"];
		expect(data.attempts).toBe(3); // 1 first + 2 retries
		expect(data.durationMs).toBeGreaterThanOrEqual(0);
		expect(data.error).toBeDefined();

		await client.close();
	});
});
