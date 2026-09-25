import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HttpClient } from "../../src/core/client.ts";
import { DeadlineExceededError, HttpError, TimeoutError } from "../../src/core/errors.ts";

/**
 * Bounding an unread Response handed back to the caller (no `parse`, or an
 * `HttpError`'s `.response`): the body's read window is capped at whichever
 * is sooner, the attempt's remaining `attemptMs` or the ticket's `totalMs`
 * deadline (measured from attempt start) — the same bound `parse` gets for
 * free by reading the body inside the attempt. See AGENTS.md / the PR that
 * introduced this: without it, `raw.json()`/`error.response.text()` on a
 * server that sends headers then stalls the body hangs forever, past both
 * deadlines.
 *
 * The bound fires by aborting with Vereda's own error (a `TimeoutError` when
 * the attempt bound fired, a `DeadlineExceededError` when the total deadline
 * fired) as the abort reason, not a bare `DOMException` — so the rejection
 * is `instanceof` the right class, `.kind`-narrowable, and its `.url` is
 * redacted the same way every other error the client builds is.
 */

interface TestServer {
	url: string;
	close: () => Promise<void>;
	setHandler: (fn: (req: IncomingMessage, res: ServerResponse) => void) => void;
}

function createTestServer(): Promise<TestServer> {
	return new Promise((resolve) => {
		let handler: (req: IncomingMessage, res: ServerResponse) => void = (_req, res) => {
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end("{}");
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

/** Sends headers immediately, then never writes or ends the body — the
 *  fetch() promise resolves (headers arrived) while the body stalls. */
function stallBody(status: number): (req: IncomingMessage, res: ServerResponse) => void {
	return (_req, res) => {
		res.writeHead(status, { "Content-Type": "application/json" });
		res.flushHeaders();
		// deliberately never res.end()
	};
}

/** Races a promise against a short test-level timer so a regression that
 *  reintroduces the hang fails fast instead of riding out the 15s suite
 *  timeout. */
function withGuard<T>(promise: Promise<T>, ms = 2_000): Promise<T> {
	return Promise.race([
		promise,
		new Promise<T>((_, reject) => {
			const t = setTimeout(() => reject(new Error(`body read did not settle within ${ms}ms`)), ms);
			t.unref();
		}),
	]);
}

function collectEvents(client: HttpClient): { name: string; data: unknown }[] {
	const events: { name: string; data: unknown }[] = [];
	for (const name of ["success", "failure", "cancelled"] as const) {
		client.on(name, (data) => events.push({ name, data }));
	}
	return events;
}

describe("bounding a handed-off Response body's read window", () => {
	let server: TestServer;

	beforeAll(async () => {
		server = await createTestServer();
	});

	afterAll(async () => {
		await server.close();
	});

	it("bounds an unparsed success response's body by the remaining attemptMs, rejecting with Vereda's TimeoutError", async () => {
		server.setHandler(stallBody(200));

		const client = HttpClient.create({ timeout: { attemptMs: 100 } });
		const events = collectEvents(client);

		const result = await client.get(`${server.url}/stall`).toPromise();
		expect(result.success).toBe(true);
		if (!result.success) return;

		const start = Date.now();
		let caught: unknown;
		try {
			await withGuard(result.raw.text());
		} catch (err) {
			caught = err;
		}
		expect(caught).toBeInstanceOf(TimeoutError);
		expect((caught as TimeoutError).kind).toBe("timeout");
		expect((caught as TimeoutError).name).toBe("TimeoutError");
		expect((caught as TimeoutError).timeoutMs).toBe(100);
		expect(Date.now() - start).toBeLessThan(1_000);

		expect(events.filter((e) => e.name === "success")).toHaveLength(1);
		expect(events.filter((e) => e.name === "failure")).toHaveLength(0);
		expect(events.filter((e) => e.name === "cancelled")).toHaveLength(0);

		await client.close();
	});

	it("bounds via the deadline cap when attemptMs is unbounded, rejecting with Vereda's DeadlineExceededError", async () => {
		server.setHandler(stallBody(200));

		const client = HttpClient.create({ timeout: { attemptMs: Infinity, totalMs: 150 } });
		const events = collectEvents(client);

		const result = await client.get(`${server.url}/stall`).toPromise();
		expect(result.success).toBe(true);
		if (!result.success) return;

		const start = Date.now();
		let caught: unknown;
		try {
			await withGuard(result.raw.text());
		} catch (err) {
			caught = err;
		}
		expect(caught).toBeInstanceOf(DeadlineExceededError);
		expect((caught as DeadlineExceededError).kind).toBe("deadline");
		expect((caught as DeadlineExceededError).name).toBe("DeadlineExceededError");
		expect((caught as DeadlineExceededError).totalMs).toBe(150);
		expect(Date.now() - start).toBeLessThan(1_000);

		expect(events.filter((e) => e.name === "success")).toHaveLength(1);
		expect(events.filter((e) => e.name === "failure")).toHaveLength(0);
		expect(events.filter((e) => e.name === "cancelled")).toHaveLength(0);

		await client.close();
	});

	it("bounds an HttpError's response body the same way, rejecting with Vereda's TimeoutError", async () => {
		server.setHandler(stallBody(404));

		const client = HttpClient.create({ timeout: { attemptMs: 100 } });

		const result = await client.get(`${server.url}/missing`).toPromise();
		expect(result.success).toBe(false);
		if (result.success) return;
		expect(result.error).toBeInstanceOf(HttpError);
		const error = result.error as HttpError;

		const start = Date.now();
		await expect(withGuard(error.response.text())).rejects.toBeInstanceOf(TimeoutError);
		expect(Date.now() - start).toBeLessThan(1_000);

		await client.close();
	});

	it("redacts a query secret in the rejection's .url, matching the client's own redaction", async () => {
		server.setHandler(stallBody(200));

		const client = HttpClient.create({ timeout: { attemptMs: 100 } });

		const result = await client.get(`${server.url}/stall?token=secret`).toPromise();
		expect(result.success).toBe(true);
		if (!result.success) return;

		let caught: unknown;
		try {
			await withGuard(result.raw.text());
		} catch (err) {
			caught = err;
		}
		expect(caught).toBeInstanceOf(TimeoutError);
		const url = (caught as TimeoutError).url;
		expect(url).not.toContain("secret");
		expect(url).toContain("token=[redacted]");

		await client.close();
	});

	it("a fast, fully-arrived body still resolves after attemptMs has elapsed, with no unhandled rejection", async () => {
		server.setHandler((_req, res) => {
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end('{"ok":true}');
		});

		const client = HttpClient.create({ timeout: { attemptMs: 50 } });

		const result = await client.get(`${server.url}/fast`).toPromise();
		expect(result.success).toBe(true);
		if (!result.success) return;

		await expect(withGuard(result.raw.text())).resolves.toBe('{"ok":true}');

		// Let the (now-moot) post-hand-off timer fire; aborting a signal whose
		// body already fully arrived is a no-op — this must not surface as an
		// unhandled rejection (vitest fails the run on those by default).
		await new Promise((r) => setTimeout(r, 150));

		await client.close();
	});

	it("the caller's own signal, aborted after resolution, still rejects the body with AbortError", async () => {
		server.setHandler(stallBody(200));

		const client = HttpClient.create({ timeout: { attemptMs: 5_000 } });
		const controller = new AbortController();

		const result = await client.get(`${server.url}/stall`, { signal: controller.signal }).toPromise();
		expect(result.success).toBe(true);
		if (!result.success) return;

		controller.abort();
		await expect(withGuard(result.raw.text())).rejects.toMatchObject({ name: "AbortError" });

		await client.close();
	});
});

describe("parse path is unaffected", () => {
	let server: TestServer;

	beforeAll(async () => {
		server = await createTestServer();
	});

	afterAll(async () => {
		await server.close();
	});

	it("still resolves normally when parse reads the body inside the attempt", async () => {
		server.setHandler((_req, res) => {
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end('{"ok":true}');
		});

		const client = HttpClient.create({ timeout: { attemptMs: 100 } });
		const result = await client
			.get<{ ok: boolean }>(`${server.url}/ok`, { parse: (d) => d as { ok: boolean } })
			.toPromise();
		expect(result).toEqual({ success: true, data: { ok: true }, raw: expect.any(Response) });

		await new Promise((r) => setTimeout(r, 150));
		await client.close();
	});
});
