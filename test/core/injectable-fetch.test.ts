import { describe, expect, it } from "vitest";
import { HttpClient } from "../../src/core/client.js";

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

		const client = HttpClient.create({ fetch: customFetch });

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

		const client = HttpClient.create({ fetch: customFetch });

		await client
			.post("https://example.com/api/data", JSON.stringify({ key: "value" }), {
				headers: { "X-Custom": "yes" },
			})
			.toPromise();

		expect(capturedInit).toBeDefined();
		expect(capturedInit?.method).toBe("POST");
		expect(capturedInit?.headers).toMatchObject({ "X-Custom": "yes" });

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

		const client = HttpClient.create();
		const result = await client.get(`http://127.0.0.1:${addr.port}/ok`).toPromise();

		expect(result.success).toBe(true);

		await client.close();
		await new Promise<void>((r) => server.close(() => r()));
	});
});
