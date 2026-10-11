import { describe, expect, it } from "vitest";
import { z } from "zod";
import { withZod } from "../../src/adapters/zod.ts";
import { HttpClient } from "../../src/core/client.ts";
import { ConfigurationError, ValidationError } from "../../src/core/errors.ts";

/** A fetch that answers every call with a fresh copy of `body`. */
function fetchReturning(body: BodyInit | null, headers: Record<string, string> = {}) {
	let calls = 0;
	const fetch: typeof globalThis.fetch = async () => {
		calls++;
		return new Response(body instanceof Uint8Array ? body.slice() : body, { status: 200, headers });
	};
	return { fetch, calls: () => calls };
}

function clientWith(fetch: typeof globalThis.fetch, attemptMs = 5_000) {
	return HttpClient.create({ timeout: { attemptMs }, retry: { maxRetries: 2 }, fetch });
}

describe("responseType (#142)", () => {
	it('"text" resolves with the decoded body, BOM stripped', async () => {
		const client = clientWith(fetchReturning("﻿héllo").fetch);
		const result = await client.get("https://x.test/", { responseType: "text" }).toPromise();
		expect(result).toMatchObject({ success: true, data: "héllo" });
		await client.close();
	});

	it('"arrayBuffer" resolves with the raw bytes', async () => {
		const client = clientWith(fetchReturning(new Uint8Array([1, 2, 3])).fetch);
		const result = await client.get("https://x.test/", { responseType: "arrayBuffer" }).toPromise();
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data).toBeInstanceOf(ArrayBuffer);
			expect([...new Uint8Array(result.data)]).toEqual([1, 2, 3]);
		}
		await client.close();
	});

	it('"blob" carries the response content-type', async () => {
		const client = clientWith(fetchReturning("abc", { "content-type": "application/x-smoke" }).fetch);
		const result = await client.get("https://x.test/", { responseType: "blob" }).toPromise();
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.type).toBe("application/x-smoke");
			expect(await result.data.text()).toBe("abc");
		}
		await client.close();
	});

	it('"none" cancels the body and resolves with undefined', async () => {
		let cancelled = false;
		const body = new ReadableStream({
			cancel() {
				cancelled = true;
			},
		});
		const client = clientWith(async () => new Response(body, { status: 200 }));
		const result = await client.get("https://x.test/", { responseType: "none" }).toPromise();
		expect(result).toMatchObject({ success: true, data: undefined });
		await Promise.resolve();
		expect(cancelled).toBe(true);
		await client.close();
	});

	it("feeds the body read as responseType to parse", async () => {
		const client = clientWith(fetchReturning("a,b,c").fetch);
		const result = await client
			.get("https://x.test/", { responseType: "text", parse: (data) => String(data).split(",") })
			.toPromise();
		expect(result).toMatchObject({ success: true, data: ["a", "b", "c"] });
		await client.close();
	});

	it("rejects an unknown responseType as a ticket ConfigurationError, before fetching", async () => {
		const f = fetchReturning("");
		const client = clientWith(f.fetch);
		// @ts-expect-error — not a ResponseType
		const result = await client.get("https://x.test/", { responseType: "xml" }).toPromise();
		expect(result.success).toBe(false);
		if (!result.success) expect(result.error).toBeInstanceOf(ConfigurationError);
		expect(f.calls()).toBe(0);
		await client.close();
	});
});

describe("async parse (#142)", () => {
	it("resolves with what the async parse returns", async () => {
		const client = clientWith(fetchReturning('{"n":1}').fetch);
		const result = await client
			.get("https://x.test/", { parse: async (data) => (data as { n: number }).n + 1 })
			.toPromise();
		expect(result).toMatchObject({ success: true, data: 2 });
		await client.close();
	});

	it("a rejected async parse is a ValidationError and is never retried", async () => {
		const f = fetchReturning("{}");
		const client = clientWith(f.fetch);
		const cause = new Error("nope");
		const result = await client
			.get("https://x.test/", {
				parse: async () => {
					throw cause;
				},
			})
			.toPromise();
		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.error).toBeInstanceOf(ValidationError);
			expect(result.error.cause).toBe(cause);
		}
		expect(f.calls()).toBe(1);
		await client.close();
	});

	it("a parse that never settles is bounded by attemptMs", async () => {
		const client = HttpClient.create({
			timeout: { attemptMs: 50 },
			retry: { maxRetries: 0 },
			fetch: fetchReturning("{}").fetch,
		});
		const result = await client.get("https://x.test/", { parse: () => new Promise<never>(() => {}) }).toPromise();
		expect(result.success).toBe(false);
		if (!result.success) expect(result.error.kind).toBe("timeout");
		await client.close();
	});

	it("cancelling the ticket ends a parse that never settles", async () => {
		const client = clientWith(fetchReturning("{}").fetch);
		let parsing!: () => void;
		const started = new Promise<void>((r) => {
			parsing = r;
		});
		const ticket = client.get("https://x.test/", {
			parse: () => {
				parsing();
				return new Promise<never>(() => {});
			},
		});
		await started;
		ticket.cancel();
		const result = await ticket.toPromise();
		expect(result.success).toBe(false);
		if (!result.success) expect(result.error.kind).toBe("cancelled");
		await client.close();
	});

	it("withZod runs async refinements", async () => {
		const Schema = z.object({ id: z.number() }).refine(async (v) => v.id > 0, "id must be positive");
		const client = clientWith(fetchReturning('{"id":-1}').fetch);
		const result = await client.get("https://x.test/", { parse: withZod(Schema) }).toPromise();
		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.error).toBeInstanceOf(ValidationError);
			expect((result.error as ValidationError).issues).toHaveLength(1);
		}
		await client.close();
	});
});
