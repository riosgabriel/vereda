import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HttpClient } from "../../src/core/client.ts";
import { ConfigurationError } from "../../src/core/errors.ts";

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

/** Collect the request body chunks into a single string. */
function readBody(req: IncomingMessage): Promise<string> {
	return new Promise((resolve) => {
		const chunks: Buffer[] = [];
		req.on("data", (c) => chunks.push(c as Buffer));
		req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
	});
}

function makeStream(payload: string): ReadableStream<Uint8Array> {
	return new ReadableStream({
		start(controller) {
			controller.enqueue(new TextEncoder().encode(payload));
			controller.close();
		},
	});
}

const fastRetry = { backoff: { baseDelayMs: 10, jitter: false } };

describe("replayable bodies", () => {
	let server: TestServer;

	beforeAll(async () => {
		server = await createTestServer();
	});

	afterAll(async () => {
		await server.close();
	});

	it("replays a factory ReadableStream body on retry (acceptance)", async () => {
		const payload = "x".repeat(1024);
		const captured: string[] = [];
		let hits = 0;
		server.setHandler(async (req, res) => {
			hits++;
			captured.push(await readBody(req));
			if (hits === 1) {
				res.writeHead(503);
				res.end("unavailable");
			} else {
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ ok: true }));
			}
		});

		const client = HttpClient.create({ timeout: { attemptMs: 5_000 } });
		const result = await client
			.post(`${server.url}/replay`, () => makeStream(payload), {
				retry: { ...fastRetry, idempotent: true },
			})
			.toPromise();

		expect(result.success).toBe(true);
		expect(hits).toBe(2);
		expect(captured).toHaveLength(2);
		expect(captured[0]).toBe(payload);
		expect(captured[1]).toBe(payload);
	}, 10_000);

	it("rejects a raw ReadableStream body with ConfigurationError (no throw)", async () => {
		let hits = 0;
		server.setHandler((_req, res) => {
			hits++;
			res.writeHead(200);
			res.end("{}");
		});

		const client = HttpClient.create({ timeout: { attemptMs: 5_000 } });
		// `!`: the expect() callback runs synchronously, so this is assigned before use.
		let ticket!: ReturnType<HttpClient["post"]>;
		expect(() => {
			ticket = client.post(`${server.url}/raw`, makeStream("hello"));
		}).not.toThrow();

		const result = await ticket.toPromise();
		expect(hits).toBe(0);
		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.error).toBeInstanceOf(ConfigurationError);
			expect(result.error.kind).toBe("configuration");
		}
	});

	it("surfaces a throwing body factory as ConfigurationError (no retry)", async () => {
		let hits = 0;
		server.setHandler(async (_req, res) => {
			hits++;
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ ok: true }));
		});

		const client = HttpClient.create({ timeout: { attemptMs: 5_000 } });
		const result = await client
			.post(
				`${server.url}/throw`,
				() => {
					throw new Error("factory broken");
				},
				{ retry: { ...fastRetry, idempotent: true } },
			)
			.toPromise();

		expect(hits).toBe(0); // request never reached the server
		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.error).toBeInstanceOf(ConfigurationError);
			expect(result.error.kind).toBe("configuration");
			expect(result.error.message).toContain("factory broken");
		}
	});

	it("replays a factory string body on retry", async () => {
		const captured: string[] = [];
		let hits = 0;
		server.setHandler(async (req, res) => {
			hits++;
			captured.push(await readBody(req));
			if (hits === 1) {
				res.writeHead(503);
				res.end("unavailable");
			} else {
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ ok: true }));
			}
		});

		const client = HttpClient.create({ timeout: { attemptMs: 5_000 } });
		const result = await client
			.post(`${server.url}/string`, () => "hello", {
				retry: { ...fastRetry, idempotent: true },
			})
			.toPromise();

		expect(result.success).toBe(true);
		expect(hits).toBe(2);
		expect(captured).toEqual(["hello", "hello"]);
	}, 10_000);
});

describe("request-level timeout/retry option validation", () => {
	let server: TestServer;

	beforeAll(async () => {
		server = await createTestServer();
	});

	afterAll(async () => {
		await server.close();
	});

	it("rejects request timeout.attemptMs: -5 with ConfigurationError, no network hit, one failure event, no TimeoutNegativeWarning", async () => {
		let hits = 0;
		server.setHandler((_req, res) => {
			hits++;
			res.writeHead(200);
			res.end("{}");
		});

		const client = HttpClient.create({ timeout: { attemptMs: 5_000 } });
		const failures: unknown[] = [];
		client.on("failure", (e) => failures.push(e));

		const warningNames: string[] = [];
		const onWarning = (w: Error) => warningNames.push(w.name);
		process.on("warning", onWarning);
		try {
			const result = await client.get(`${server.url}/bad-timeout`, { timeout: { attemptMs: -5 } }).toPromise();

			expect(hits).toBe(0);
			expect(result.success).toBe(false);
			if (!result.success) {
				expect(result.error).toBeInstanceOf(ConfigurationError);
				expect(result.error.kind).toBe("configuration");
				expect((result.error as ConfigurationError).key).toBe("request.timeout.attemptMs must be positive");
			}
			expect(failures).toHaveLength(1);

			// Give any async process warning a tick to land before asserting its absence.
			await new Promise((r) => setImmediate(r));
			expect(warningNames).not.toContain("TimeoutNegativeWarning");
		} finally {
			process.off("warning", onWarning);
		}
	});

	it("rejects request retry.maxRetries: -1 with ConfigurationError, no network hit, one failure event", async () => {
		let hits = 0;
		server.setHandler((_req, res) => {
			hits++;
			res.writeHead(200);
			res.end("{}");
		});

		const client = HttpClient.create({ timeout: { attemptMs: 5_000 } });
		const failures: unknown[] = [];
		client.on("failure", (e) => failures.push(e));

		const result = await client.get(`${server.url}/bad-retry`, { retry: { maxRetries: -1 } }).toPromise();

		expect(hits).toBe(0);
		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.error).toBeInstanceOf(ConfigurationError);
			expect(result.error.kind).toBe("configuration");
			expect((result.error as ConfigurationError).key).toBe("request.retry.maxRetries must be a non-negative integer");
		}
		expect(failures).toHaveLength(1);
	});

	it("rejects an invalid request retry.backoff field with ConfigurationError, no network hit, one failure event", async () => {
		let hits = 0;
		server.setHandler((_req, res) => {
			hits++;
			res.writeHead(200);
			res.end("{}");
		});

		const client = HttpClient.create({ timeout: { attemptMs: 5_000 } });
		const failures: unknown[] = [];
		client.on("failure", (e) => failures.push(e));

		const result = await client
			.get(`${server.url}/bad-backoff`, { retry: { backoff: { baseDelayMs: -1 } } })
			.toPromise();

		expect(hits).toBe(0);
		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.error).toBeInstanceOf(ConfigurationError);
			expect(result.error.kind).toBe("configuration");
			expect((result.error as ConfigurationError).key).toBe("request.retry.backoff.baseDelayMs must be non-negative");
		}
		expect(failures).toHaveLength(1);
	});

	it("accepts request timeout.attemptMs: Infinity as an explicit opt-out — request actually proceeds", async () => {
		let hits = 0;
		server.setHandler((_req, res) => {
			hits++;
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ ok: true }));
		});

		const client = HttpClient.create({ timeout: { attemptMs: 5_000 } });
		const result = await client.get(`${server.url}/no-cap`, { timeout: { attemptMs: Infinity } }).toPromise();

		expect(hits).toBe(1);
		expect(result.success).toBe(true);
	});

	it("accepts a request with timeout omitted — inherits the client default", async () => {
		let hits = 0;
		server.setHandler((_req, res) => {
			hits++;
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ ok: true }));
		});

		const client = HttpClient.create({ timeout: { attemptMs: 5_000 } });
		const result = await client.get(`${server.url}/inherits-default`).toPromise();

		expect(hits).toBe(1);
		expect(result.success).toBe(true);
	});
});
