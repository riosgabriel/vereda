import { describe, expect, it } from "vitest";
import { HttpClient } from "../../src/core/client.ts";
import { redactUrl } from "../../src/core/redact.ts";
import type { LifecycleEventMap } from "../../src/core/types.ts";
import { requestLogger } from "../../src/middleware/index.ts";

const fastRetry = { backoff: { baseDelayMs: 1, jitter: false } } as const;

/** Never settles until the attempt's signal aborts. */
const hang: typeof globalThis.fetch = (_input, init) =>
	new Promise((_resolve, reject) => {
		init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
	});

function recordTerminalEvents(client: HttpClient): string[] {
	const events: string[] = [];
	for (const e of ["success", "failure", "cancelled"] as const) client.on(e, () => events.push(e));
	return events;
}

describe("retries with baseUrl (B16)", () => {
	it("every retry fetches baseUrl + path, not the bare relative path", async () => {
		const fetched: string[] = [];
		const client = HttpClient.create({
			baseUrl: "http://api.test",
			timeout: { attemptMs: 1_000 },
			retry: fastRetry,
			fetch: async (input) => {
				fetched.push(String(input));
				return new Response("{}", { status: fetched.length < 3 ? 503 : 200 });
			},
		});

		const result = await client.get("/users").toPromise();
		expect(result.success).toBe(true);
		expect(fetched).toEqual(["http://api.test/users", "http://api.test/users", "http://api.test/users"]);
	});
});

describe("partition-level totalMs (B4)", () => {
	it("applies to a host-derived partition", async () => {
		const client = HttpClient.create({
			timeout: { attemptMs: 1_000 },
			fetch: hang,
			partitions: { "svc.test": { timeout: { totalMs: 30 } } },
		});

		const result = await client.get("http://svc.test/slow").toPromise();
		expect(result.success === false && result.error.kind).toBe("deadline");
	});

	it("applies with baseUrl + a relative path", async () => {
		const client = HttpClient.create({
			baseUrl: "http://svc.test:8080",
			timeout: { attemptMs: 1_000 },
			fetch: hang,
			partitions: { "svc.test:8080": { timeout: { totalMs: 30 } } },
		});

		const result = await client.get("/slow").toPromise();
		expect(result.success === false && result.error.kind).toBe("deadline");
	});
});

describe("first-attempt deadline event (B7)", () => {
	it("emits failure (not cancelled) when the deadline fires during the first attempt", async () => {
		const client = HttpClient.create({ timeout: { attemptMs: 1_000, totalMs: 20 }, fetch: hang });
		const events = recordTerminalEvents(client);

		const result = await client.get("http://svc.test/").toPromise();
		expect(result.success === false && result.error.kind).toBe("deadline");
		expect(events).toEqual(["failure"]);
	});

	it("still emits cancelled when the user cancels the first attempt", async () => {
		const client = HttpClient.create({ timeout: { attemptMs: 1_000, totalMs: 5_000 }, fetch: hang });
		const events = recordTerminalEvents(client);

		const ticket = client.get("http://svc.test/");
		setTimeout(() => ticket.cancel(), 10);
		const result = await ticket.toPromise();
		await new Promise((r) => setTimeout(r, 10));
		expect(result.success === false && result.error.kind).toBe("cancelled");
		expect(events).toEqual(["cancelled"]);
	});
});

describe("redaction (B5)", () => {
	const SECRET = "s3cr3t";
	const url = `http://svc.test/x?token=${SECRET}`;

	it("redacts the failure event url when retryWhen/the policy vetoes", async () => {
		const client = HttpClient.create({
			timeout: { attemptMs: 1_000 },
			fetch: async () => new Response(null, { status: 404 }),
		});
		const failures: LifecycleEventMap["failure"][] = [];
		client.on("failure", (e) => failures.push(e));

		await client.get(url).toPromise();
		expect(failures[0]?.url).not.toContain(SECRET);
	});

	it("redacts URLs embedded in TimeoutError, on the first attempt and in retries", async () => {
		for (const maxRetries of [0, 1]) {
			const client = HttpClient.create({
				timeout: { attemptMs: 10 },
				retry: { ...fastRetry, maxRetries },
				fetch: hang,
			});
			const result = await client.get(url).toPromise();
			expect(result.success).toBe(false);
			if (!result.success) {
				expect(result.error.message).not.toContain(SECRET);
				expect(String((result.error as { lastError?: { url?: string } }).lastError?.url ?? "")).not.toContain(SECRET);
			}
		}
	});

	it("redacts URLs embedded in DeadlineExceededError", async () => {
		const client = HttpClient.create({ timeout: { attemptMs: 1_000, totalMs: 20 }, fetch: hang });
		const result = await client.get(url).toPromise();
		expect(result.success === false && result.error.kind).toBe("deadline");
		expect(result.success === false && result.error.message).not.toContain(SECRET);
	});

	it("keeps raw URLs in errors when redactQuery is false", async () => {
		const client = HttpClient.create({
			timeout: { attemptMs: 10 },
			retry: { maxRetries: 0 },
			redactQuery: false,
			fetch: hang,
		});
		const result = await client.get(url).toPromise();
		expect(result.success === false && result.error.message).toContain(SECRET);
	});

	it("redactUrl strips userinfo credentials", () => {
		expect(redactUrl("https://bob:hunter2@api.test/p?q=1#f")).toBe("https://[redacted]@api.test/p?q=[redacted]#f");
		expect(redactUrl("https://token@api.test/")).toBe("https://[redacted]@api.test/");
		// An @ in the path or query is not userinfo.
		expect(redactUrl("https://api.test/users/@me")).toBe("https://api.test/users/@me");
		expect(redactUrl("/relative?email=a@b.test")).toBe("/relative?email=[redacted]");
	});

	it("requestLogger redacts by default and can opt out", async () => {
		for (const [redactQuery, expectSecret] of [
			[undefined, false],
			[false, true],
		] as const) {
			const logged: unknown[] = [];
			const client = HttpClient.create({
				timeout: { attemptMs: 1_000 },
				fetch: async () => new Response("{}", { status: 200 }),
			});
			client.use(requestLogger({ log: (_msg, meta) => logged.push(meta.url), redactQuery }));
			await client.get(url).toPromise();
			expect(String(logged[0]).includes(SECRET)).toBe(expectSecret);
		}
	});
});

describe("malformed JSON body (B6)", () => {
	it("resolves with a ValidationError and is never retried", async () => {
		let calls = 0;
		const client = HttpClient.create({
			timeout: { attemptMs: 1_000 },
			retry: fastRetry,
			fetch: async () => {
				calls++;
				return new Response("<html>oops</html>", { status: 200 });
			},
		});

		const result = await client.get("http://svc.test/", { parse: (d) => d }).toPromise();
		expect(result.success === false && result.error.kind).toBe("validation");
		expect(calls).toBe(1);
	});

	it("a body stream that dies mid-read is still a retriable network error", async () => {
		let calls = 0;
		const client = HttpClient.create({
			timeout: { attemptMs: 1_000 },
			retry: { ...fastRetry, maxRetries: 1 },
			fetch: async () => {
				calls++;
				const body = new ReadableStream({
					start(controller) {
						controller.enqueue(new TextEncoder().encode('{"a":'));
						controller.error(new TypeError("terminated"));
					},
				});
				return new Response(body, { status: 200 });
			},
		});

		const result = await client.get("http://svc.test/", { parse: (d) => d }).toPromise();
		expect(result.success === false && result.error.kind).toBe("max_retries");
		expect(calls).toBe(2);
	});
});
