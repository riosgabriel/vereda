import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpClient } from "../../src/core/client.ts";
import { CancelledError, HttpError, NetworkError } from "../../src/core/errors.ts";
import { json } from "../../src/core/index.ts";
import { DEFAULT_FAILURE_THRESHOLD, DEFAULT_RESET_TIMEOUT_MS } from "../../src/core/types.ts";
import { Bulkhead } from "../../src/queue/bulkhead.ts";
import { CircuitBreaker } from "../../src/queue/circuit-breaker.ts";

/**
 * Edge paths in src/queue that the scenario tests don't reach (T1, #136):
 * each one is a real outcome a caller can hit, pinned so a refactor can't
 * silently change it.
 */

const FAST_RETRY = { maxRetries: 2, backoff: { baseDelayMs: 1, maxDelayMs: 1, jitter: false } };

/** Honors the abort signal like undici: rejects with its reason on abort. */
function hang(signal: AbortSignal | null | undefined): Promise<never> {
	return new Promise((_, reject) => {
		signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
	});
}

describe("retry loop", () => {
	it("fails with circuit_open when the breaker opens between attempts", async () => {
		let hits = 0;
		const client = HttpClient.create({
			timeout: { attemptMs: 1_000 },
			retry: FAST_RETRY,
			circuitBreaker: { enabled: true, failureThreshold: 1 },
			fetch: async () => {
				hits++;
				return new Response("busy", { status: 503 });
			},
		});
		const failures: string[] = [];
		client.on("failure", (e) => failures.push(e.error.kind));

		const result = await client.get("http://svc/x").toPromise();

		// The first attempt's 503 trips the breaker, so the retry is refused
		// before it reaches the host.
		expect(hits).toBe(1);
		expect(result.success).toBe(false);
		if (!result.success) expect(result.error.kind).toBe("circuit_open");
		expect(failures).toEqual(["circuit_open"]);
	});

	it("a retry cancelled while waiting for a partition slot reports cancelled, not dispatched (B9)", async () => {
		const attempts = new Map<string, number>();
		const client = HttpClient.create({
			timeout: { attemptMs: 5_000 },
			retry: FAST_RETRY,
			partitions: { svc: { concurrency: 1 } },
			fetch: async (input, init) => {
				const url = String(input);
				const n = (attempts.get(url) ?? 0) + 1;
				attempts.set(url, n);
				if (n === 1) return new Response("busy", { status: 503 });
				// A's retry holds the only slot; B's retry waits behind it.
				return url.endsWith("/a") ? hang(init?.signal) : new Response("{}", { status: 200 });
			},
		});
		const cancelled: number[] = [];
		client.on("cancelled", (e) => cancelled.push(e.attempts));

		const a = client.get("http://svc/a", { partition: "svc" });
		const b = client.get("http://svc/b", { partition: "svc" });
		await vi.waitFor(() => expect(client.partitions()[0]?.queued).toBe(1));
		b.cancel();

		const result = await b.toPromise();
		expect(result.success).toBe(false);
		if (!result.success) expect(result.error.kind).toBe("cancelled");
		await vi.waitFor(() => expect(cancelled).toEqual([1]));
		expect(attempts.get("http://svc/b")).toBe(1);

		a.cancel();
		await a.toPromise();
	});
});

describe("executor", () => {
	it("cancelling after fetch resolved cancels the unread body (B13)", async () => {
		let bodyCancelled = false;
		const body = new ReadableStream({
			cancel() {
				bodyCancelled = true;
			},
		});
		const client = HttpClient.create({
			timeout: { attemptMs: 5_000 },
			retry: { maxRetries: 0 },
			// Ignores the signal, so only the executor can release the body.
			fetch: async () => new Response(body, { status: 200 }),
		});
		client.use(async (ctx, next) => {
			const res = await next(ctx);
			await new Promise((r) => setTimeout(r, 50));
			return res;
		});

		const ticket = client.get("http://svc/x", { parse: json() });
		setTimeout(() => ticket.cancel(), 10);
		const result = await ticket.toPromise();

		expect(result.success).toBe(false);
		if (!result.success) expect(result.error.kind).toBe("cancelled");
		await vi.waitFor(() => expect(bodyCancelled).toBe(true));
	});

	it("parse on a bodiless response (204) is a ValidationError, never retried", async () => {
		let hits = 0;
		const client = HttpClient.create({
			timeout: { attemptMs: 1_000 },
			retry: FAST_RETRY,
			fetch: async () => {
				hits++;
				return new Response(null, { status: 204 });
			},
		});

		const result = await client.get("http://svc/x", { parse: json() }).toPromise();

		expect(hits).toBe(1);
		expect(result.success).toBe(false);
		if (!result.success) expect(result.error.kind).toBe("validation");
	});

	it("a body factory that throws a non-Error is a ConfigurationError naming the value", async () => {
		const client = HttpClient.create({ timeout: { attemptMs: 1_000 }, fetch: async () => new Response("{}") });

		const result = await client
			.post("http://svc/x", () => {
				throw "no body today";
			})
			.toPromise();

		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.error.kind).toBe("configuration");
			expect(result.error.message).toContain("no body today");
		}
	});

	it("a transport that rejects with a non-Error is a NetworkError carrying it as cause", async () => {
		const client = HttpClient.create({
			timeout: { attemptMs: 1_000 },
			retry: { maxRetries: 0 },
			fetch: () => Promise.reject("socket hang up"),
		});

		const result = await client.get("http://svc/x").toPromise();

		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.error).toBeInstanceOf(NetworkError);
			expect(result.error.cause).toBe("socket hang up");
		}
	});

	it("a parse error exposing `errors` (e.g. AggregateError) surfaces them as issues", async () => {
		const client = HttpClient.create({ timeout: { attemptMs: 1_000 }, fetch: async () => new Response("{}") });
		const problems = [new Error("a"), new Error("b")];

		const result = await client
			.get("http://svc/x", {
				parse: () => {
					throw new AggregateError(problems, "invalid");
				},
			})
			.toPromise();

		expect(result.success).toBe(false);
		if (!result.success && result.error.kind === "validation") expect(result.error.issues).toEqual(problems);
		else expect.unreachable("expected a validation error");
	});
});

describe("Bulkhead", () => {
	it("run() with an already-aborted signal rejects without running the task", async () => {
		const bh = new Bulkhead("test", { concurrency: 1 });
		const task = vi.fn(async () => "ran");

		await expect(bh.run(task, undefined, undefined, AbortSignal.abort())).rejects.toBeInstanceOf(CancelledError);
		expect(task).not.toHaveBeenCalled();
		expect(bh.isIdle).toBe(true);
	});

	it("a retained reference's release is idempotent", () => {
		const bh = new Bulkhead("test", { concurrency: 1 });
		const releaseA = bh.retain();
		const releaseB = bh.retain();

		releaseA();
		releaseA();
		expect(bh.isIdle).toBe(false); // B still holds it

		releaseB();
		expect(bh.isIdle).toBe(true);
	});
});

describe("CircuitBreaker", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("uses the default failureThreshold and resetTimeoutMs when omitted", () => {
		vi.useFakeTimers();
		const cb = new CircuitBreaker("test", { enabled: true });

		for (let i = 0; i < DEFAULT_FAILURE_THRESHOLD - 1; i++) cb.recordFailure(new NetworkError("boom"));
		expect(cb.canRequest()).toBe(true);
		cb.recordFailure(new NetworkError("boom"));
		expect(cb.canRequest()).toBe(false);

		vi.advanceTimersByTime(DEFAULT_RESET_TIMEOUT_MS);
		expect(cb.canRequest()).toBe(true); // half-open trial
	});

	it("recordFailure ignores errors the classifier doesn't count (default: 4xx)", () => {
		const cb = new CircuitBreaker("test", { enabled: true, failureThreshold: 1 });

		cb.recordFailure(new HttpError("HTTP 404", 404, new Response(null, { status: 404 })));

		expect(cb.canRequest()).toBe(true);
	});

	it("outcomes recorded while open don't change state", () => {
		const cb = new CircuitBreaker("test", { enabled: true, failureThreshold: 1, resetTimeoutMs: 60_000 });
		cb.recordFailure(new NetworkError("boom"));
		expect(cb.canRequest()).toBe(false);

		// A straggler attempt admitted before the trip reports in late.
		cb.recordSuccess();
		cb.recordFailure(new NetworkError("boom"));

		expect(cb.canRequest()).toBe(false);
	});

	it("a permit settles once: a second outcome is ignored", () => {
		const cb = new CircuitBreaker("test", { enabled: true, failureThreshold: 1 });
		const permit = cb.tryAcquire();
		if (!permit) return expect.unreachable("closed breaker refused a permit");

		permit.success();
		permit.failure(new NetworkError("boom"));

		expect(cb.canRequest()).toBe(true);
	});
});
