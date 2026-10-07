import { describe, expect, it } from "vitest";
import { HttpClient } from "../../src/core/client.ts";
import type { RedirectMode } from "../../src/core/types.ts";

describe("Injectable fetch (6.4)", () => {
	it("uses a custom fetch function instead of globalThis.fetch", async () => {
		let fetchWasCalled = false;
		let fetchedUrl = "";

		const customFetch: typeof globalThis.fetch = async (input, _init) => {
			fetchWasCalled = true;
			fetchedUrl = typeof input === "string" ? input : input.toString();
			return new Response(JSON.stringify({ custom: true }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		};

		const client = HttpClient.create({ timeout: { attemptMs: 5_000 }, fetch: customFetch });

		const result = await client
			.get<{ custom: boolean }>("https://example.com/api/test", {
				parse: (data: unknown) => data as { custom: boolean },
			})
			.toPromise();

		expect(fetchWasCalled).toBe(true);
		expect(fetchedUrl).toContain("example.com/api/test");
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data).toEqual({ custom: true });
		}

		await client.close();
	});

	it("passes method, headers, and body to custom fetch", async () => {
		let capturedInit: RequestInit | undefined;

		const customFetch: typeof globalThis.fetch = async (_input, init) => {
			capturedInit = init;
			return new Response("{}", {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		};

		const client = HttpClient.create({ timeout: { attemptMs: 5_000 }, fetch: customFetch });

		await client
			.post("https://example.com/api/data", JSON.stringify({ key: "value" }), {
				headers: { "X-Custom": "yes" },
			})
			.toPromise();

		expect(capturedInit).toBeDefined();
		expect(capturedInit?.method).toBe("POST");
		expect(new Headers(capturedInit?.headers).get("X-Custom")).toBe("yes");

		await client.close();
	});

	it("retries with the same custom fetch on failure", async () => {
		let callCount = 0;

		const customFetch: typeof globalThis.fetch = async () => {
			callCount++;
			if (callCount < 3) {
				return new Response("Service Unavailable", { status: 503 });
			}
			return new Response(JSON.stringify({ ok: true }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		};

		const client = HttpClient.create({
			timeout: { attemptMs: 5_000 },
			fetch: customFetch,
			retry: {
				maxRetries: 3,
				retryOnStatus: [503],
				backoff: { baseDelayMs: 10, jitter: false },
			},
		});

		const result = await client.get("https://example.com/api/retry").toPromise();

		expect(callCount).toBe(3);
		expect(result.success).toBe(true);

		await client.close();
	});

	it("uses globalThis.fetch when no custom fetch is provided", async () => {
		const { createServer } = await import("node:http");
		const server = createServer((_req, res) => {
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ ok: true }));
		});
		await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
		const addr = server.address() as { port: number };

		const client = HttpClient.create({ timeout: { attemptMs: 5_000 } });
		const result = await client.get(`http://127.0.0.1:${addr.port}/ok`).toPromise();

		expect(result.success).toBe(true);

		await client.close();
		await new Promise<void>((r) => server.close(() => r()));
	});

	describe("redirect option", () => {
		it("leaves redirect unset on the fetch init when not configured", async () => {
			let capturedInit: RequestInit | undefined;
			const customFetch: typeof globalThis.fetch = async (_input, init) => {
				capturedInit = init;
				return new Response("{}", { status: 200 });
			};

			const client = HttpClient.create({ timeout: { attemptMs: 5_000 }, fetch: customFetch });
			await client.get("https://example.com/").toPromise();

			expect(capturedInit).toBeDefined();
			expect(capturedInit?.redirect).toBeUndefined();

			await client.close();
		});

		it("passes the configured redirect mode to custom fetch on every attempt", async () => {
			const modes: Array<RequestRedirect | undefined> = [];
			const customFetch: typeof globalThis.fetch = async (_input, init) => {
				modes.push(init?.redirect);
				return modes.length < 2 ? new Response("", { status: 503 }) : new Response("{}", { status: 200 });
			};

			const client = HttpClient.create({
				timeout: { attemptMs: 5_000 },
				fetch: customFetch,
				redirect: "manual",
				retry: { maxRetries: 1, retryOnStatus: [503], backoff: { baseDelayMs: 1, jitter: false } },
			});
			const result = await client.get("https://example.com/").toPromise();

			expect(result.success).toBe(true);
			expect(modes).toEqual(["manual", "manual"]);

			await client.close();
		});

		it('rejects redirect: "error" at create(), pointing to "manual"', () => {
			// fetch's "error" mode throws a TypeError on a 3xx, which the executor
			// can't tell from a network failure: one request to a redirecting URL
			// was retried until it opened the circuit breaker for the partition.
			expect(() =>
				HttpClient.create({ timeout: { attemptMs: 5_000 }, redirect: "error" as unknown as RedirectMode }),
			).toThrow(/use "manual" to reject redirects/);
		});

		it('a 3xx under redirect: "manual" is not retried and does not trip the breaker', async () => {
			const { createServer } = await import("node:http");
			let hits = 0;
			const server = createServer((_req, res) => {
				hits++;
				res.writeHead(302, { Location: "/elsewhere" });
				res.end();
			});
			await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
			const addr = server.address() as { port: number };
			const url = `http://127.0.0.1:${addr.port}/start`;

			const client = HttpClient.create({
				timeout: { attemptMs: 5_000 },
				redirect: "manual",
				retry: { maxRetries: 3, backoff: { baseDelayMs: 1, jitter: false } },
				circuitBreaker: { enabled: true, failureThreshold: 2 },
			});

			const first = await client.get(url).toPromise();
			const second = await client.get(url).toPromise();

			// A redirect is the server's deliberate answer: asking again gets the same one.
			expect(hits).toBe(2);
			for (const result of [first, second]) {
				expect(result.success).toBe(false);
				if (!result.success && result.error.kind === "http") {
					expect(result.error.statusCode).toBe(302);
					await result.error.response.body?.cancel();
				} else expect.unreachable("expected an HttpError, not a retried/circuit_open failure");
			}

			await client.close();
			await new Promise<void>((r) => server.close(() => r()));
		});

		it("exposes the redirect mode to middleware, which can override it per attempt", async () => {
			const seen: Array<RedirectMode | undefined> = [];
			const inits: Array<RequestRedirect | undefined> = [];
			const client = HttpClient.create({
				timeout: { attemptMs: 5_000 },
				redirect: "manual",
				fetch: async (_input, init) => {
					inits.push(init?.redirect);
					return new Response("{}", { status: 200 });
				},
			});
			client.use(async (ctx, next) => {
				seen.push(ctx.redirect);
				return next({ ...ctx, redirect: "follow" });
			});

			await client.get("https://example.com/").toPromise();

			expect(seen).toEqual(["manual"]);
			expect(inits).toEqual(["follow"]);
			await client.close();
		});

		it("returns a 3xx as a readable HttpError with redirect: manual, without following it", async () => {
			const { createServer } = await import("node:http");
			const hits: string[] = [];
			const server = createServer((req, res) => {
				hits.push(req.url ?? "");
				if (req.url === "/start") {
					res.writeHead(302, { Location: "http://169.254.169.254/latest/meta-data/" });
					res.end();
					return;
				}
				res.writeHead(200);
				res.end("followed");
			});
			await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
			const addr = server.address() as { port: number };

			// No custom fetch: the mode must reach globalThis.fetch too.
			const client = HttpClient.create({ timeout: { attemptMs: 5_000 }, redirect: "manual" });
			const result = await client.get(`http://127.0.0.1:${addr.port}/start`).toPromise();

			expect(result.success).toBe(false);
			if (!result.success) {
				expect(result.error.kind).toBe("http");
				if (result.error.kind === "http") {
					expect(result.error.statusCode).toBe(302);
					expect(result.error.response.headers.get("location")).toBe("http://169.254.169.254/latest/meta-data/");
					await result.error.response.body?.cancel();
				}
			}
			expect(hits).toEqual(["/start"]);

			await client.close();
			await new Promise<void>((r) => server.close(() => r()));
		});
	});
});
