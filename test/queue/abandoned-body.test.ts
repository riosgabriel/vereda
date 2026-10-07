import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HttpClient } from "../../src/core/client.ts";
import { json } from "../../src/core/index.ts";

/**
 * B13 (#133): an attempt that ends without handing its Response to the caller
 * must release the body, even when the transport ignores the attempt signal
 * (an injected `fetch` that drops `signal`, or middleware that swaps
 * `ctx.signal`). Undici ties the body to the fetch signal, so the real `fetch`
 * was already fine; a signal-deaf transport left `parse` reading forever, past
 * `attemptMs`, and held the socket until GC.
 */

interface TestServer {
	url: string;
	close: () => Promise<void>;
	setHandler: (fn: (req: IncomingMessage, res: ServerResponse) => void) => void;
	/** Resolves when the server sees the current request's connection close. */
	closed: () => Promise<void>;
}

function createTestServer(): Promise<TestServer> {
	return new Promise((resolve) => {
		let handler: (req: IncomingMessage, res: ServerResponse) => void = () => {};
		let onClose: Promise<void> = Promise.resolve();
		const server = createServer((req, res) => {
			onClose = new Promise((r) => res.on("close", () => r()));
			handler(req, res);
		});
		server.listen(0, "127.0.0.1", () => {
			const addr = server.address() as { port: number };
			resolve({
				url: `http://127.0.0.1:${addr.port}`,
				close: () => {
					server.closeAllConnections();
					return new Promise((r) => server.close(() => r()));
				},
				setHandler: (fn) => {
					handler = fn;
				},
				closed: () => onClose,
			});
		});
	});
}

/** Headers and the start of a JSON array, then one more element every 20ms, never ending. */
function trickle(_req: IncomingMessage, res: ServerResponse): void {
	res.writeHead(200, { "Content-Type": "application/json" });
	res.write("[");
	const timer = setInterval(() => res.write("1,"), 20);
	res.on("close", () => clearInterval(timer));
}

/** A `fetch` wrapper that forgets to forward the signal. */
const signalDeafFetch: typeof fetch = (input, init) => fetch(input, { ...init, signal: undefined });

/** Bun's fetch (1.3.x) never closes the client socket after an abort, so a
 *  `node:http` server doesn't see `close` there even for the 503 path that
 *  already cancelled its body before B13. Socket release is asserted under
 *  Node only; the timing assertions (the ticket settles within its bound) run
 *  on both runtimes. See the same IS_BUN pattern in retry-matrix.test.ts. */
const IS_BUN = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";

async function expectSocketReleased(server: TestServer): Promise<void> {
	if (IS_BUN) return;
	await within(500, server.closed());
}

/** Fails fast instead of riding out the suite timeout if the hang comes back. */
function within<T>(ms: number, p: Promise<T>): Promise<T> {
	return Promise.race([
		p,
		new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`still pending after ${ms}ms`)), ms)),
	]);
}

describe("abandoned response bodies are released (B13, #133)", () => {
	let server: TestServer;

	beforeAll(async () => {
		server = await createTestServer();
	});

	afterAll(async () => {
		await server.close();
	});

	it("attemptMs bounds a parse read when fetch ignores the signal", async () => {
		server.setHandler(trickle);
		const client = HttpClient.create({ retry: { maxRetries: 0 }, timeout: { attemptMs: 100 }, fetch: signalDeafFetch });

		const result = await within(1_000, client.get(`${server.url}/slow`, { parse: json() }).toPromise());

		expect(result.success).toBe(false);
		if (!result.success) expect(result.error.kind).toBe("timeout");
		await expectSocketReleased(server);
	});

	it("totalMs bounds a parse read when fetch ignores the signal", async () => {
		server.setHandler(trickle);
		const client = HttpClient.create({
			retry: { maxRetries: 0 },
			timeout: { attemptMs: Number.POSITIVE_INFINITY, totalMs: 100 },
			fetch: signalDeafFetch,
		});

		const result = await within(1_000, client.get(`${server.url}/slow`, { parse: json() }).toPromise());

		expect(result.success).toBe(false);
		if (!result.success) expect(result.error.kind).toBe("deadline");
		await expectSocketReleased(server);
	});

	it("cancel() stops a parse read when fetch ignores the signal", async () => {
		server.setHandler(trickle);
		const client = HttpClient.create({
			retry: { maxRetries: 0 },
			timeout: { attemptMs: Number.POSITIVE_INFINITY },
			fetch: signalDeafFetch,
		});

		const ticket = client.get(`${server.url}/slow`, { parse: json() });
		setTimeout(() => ticket.cancel(), 50);

		await expectSocketReleased(server);
		expect(client.partitions().every((p) => p.running === 0)).toBe(true);
	});

	it("cancels the body when the attempt timer fires after fetch resolved", async () => {
		server.setHandler(trickle);
		const client = HttpClient.create({ retry: { maxRetries: 0 }, timeout: { attemptMs: 50 } });
		// Swaps the signal and holds the response past attemptMs, so the executor
		// sees a resolved Response whose attempt has already timed out.
		client.use(async (ctx, next) => {
			const res = await next({ ...ctx, signal: new AbortController().signal });
			await new Promise((r) => setTimeout(r, 150));
			return res;
		});

		const result = await within(1_000, client.get(`${server.url}/slow`, { parse: json() }).toPromise());

		expect(result.success).toBe(false);
		if (!result.success) expect(result.error.kind).toBe("timeout");
		await expectSocketReleased(server);
	});
});

describe("parse reads JSON like response.json()", () => {
	let server: TestServer;

	beforeAll(async () => {
		server = await createTestServer();
	});

	afterAll(async () => {
		await server.close();
	});

	function respond(chunks: (string | Buffer)[]): (req: IncomingMessage, res: ServerResponse) => void {
		return (_req, res) => {
			res.writeHead(200, { "Content-Type": "application/json" });
			for (const chunk of chunks) res.write(chunk);
			res.end();
		};
	}

	const client = HttpClient.create({ retry: { maxRetries: 0 }, timeout: { attemptMs: 5_000 } });

	it("strips a leading BOM", async () => {
		server.setHandler(respond(["﻿", '{"ok":true}']));
		const result = await client.get(`${server.url}/bom`, { parse: json<{ ok: boolean }>() }).toPromise();
		expect(result.success && result.data).toEqual({ ok: true });
	});

	it("decodes a multi-byte character split across chunks", async () => {
		const bytes = Buffer.from('{"city":"São Paulo"}');
		const split = bytes.indexOf(0xc3) + 1; // between the two bytes of "ã"
		server.setHandler(respond([bytes.subarray(0, split), bytes.subarray(split)]));
		const result = await client.get(`${server.url}/utf8`, { parse: json<{ city: string }>() }).toPromise();
		expect(result.success && result.data).toEqual({ city: "São Paulo" });
	});

	it("an empty body is a ValidationError, not a NetworkError (B6)", async () => {
		server.setHandler(respond([]));
		const result = await client.get(`${server.url}/empty`, { parse: json() }).toPromise();
		expect(result.success).toBe(false);
		if (!result.success) expect(result.error.kind).toBe("validation");
	});
});
