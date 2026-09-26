import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HttpClient } from "../../src/core/client.ts";
import { MaxRetriesExceededError } from "../../src/core/errors.ts";

interface TestServer {
	url: string;
	close: () => Promise<void>;
	setHandler: (fn: (req: IncomingMessage, res: ServerResponse) => void) => void;
}

function createTestServer(): Promise<TestServer> {
	return new Promise((resolve) => {
		let handler: (req: IncomingMessage, res: ServerResponse) => void = (req, res) => {
			res.writeHead(200, { "Content-Type": "application/json", "X-Method-Seen": req.method ?? "" });
			res.end(req.method === "HEAD" ? undefined : JSON.stringify({ ok: true }));
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

describe("HttpClient convenience methods", () => {
	let server: TestServer;
	let client: HttpClient;

	beforeAll(async () => {
		server = await createTestServer();
		client = HttpClient.create({ timeout: { attemptMs: 200 } });
	});

	afterAll(async () => {
		await server.close();
	});

	it("head() sends a HEAD request", async () => {
		server.setHandler((req, res) => {
			expect(req.method).toBe("HEAD");
			res.writeHead(200);
			res.end();
		});
		const result = await client.head(`${server.url}/resource`).toPromise();
		expect(result.success).toBe(true);
	});

	it("options() sends an OPTIONS request", async () => {
		server.setHandler((req, res) => {
			expect(req.method).toBe("OPTIONS");
			res.writeHead(204, { Allow: "GET, POST" });
			res.end();
		});
		const result = await client.options(`${server.url}/resource`).toPromise();
		expect(result.success).toBe(true);
	});

	it("put() sends a PUT request with a body", async () => {
		server.setHandler((req, res) => {
			expect(req.method).toBe("PUT");
			let body = "";
			req.on("data", (chunk) => {
				body += chunk;
			});
			req.on("end", () => {
				expect(body).toBe(JSON.stringify({ name: "updated" }));
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ ok: true }));
			});
		});
		const result = await client.put(`${server.url}/resource/1`, JSON.stringify({ name: "updated" })).toPromise();
		expect(result.success).toBe(true);
	});

	it("patch() sends a PATCH request with a body", async () => {
		server.setHandler((req, res) => {
			expect(req.method).toBe("PATCH");
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ ok: true }));
		});
		const result = await client.patch(`${server.url}/resource/1`, JSON.stringify({ name: "x" })).toPromise();
		expect(result.success).toBe(true);
	});

	it("delete() sends a DELETE request", async () => {
		server.setHandler((req, res) => {
			expect(req.method).toBe("DELETE");
			res.writeHead(204);
			res.end();
		});
		const result = await client.delete(`${server.url}/resource/1`).toPromise();
		expect(result.success).toBe(true);
	});

	it("with retry.maxRetries: 0, surfaces the raw error without wrapping it in MaxRetriesExceededError", async () => {
		server.setHandler((_req, res) => {
			res.writeHead(503, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "unavailable" }));
		});
		const zeroRetryClient = HttpClient.create({
			timeout: { attemptMs: 200 },
			retry: { maxRetries: 0, retryOnStatus: [503] },
		});
		const result = await zeroRetryClient.get(`${server.url}/always-503`).toPromise();
		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.error).not.toBeInstanceOf(MaxRetriesExceededError);
		}
	});
});
