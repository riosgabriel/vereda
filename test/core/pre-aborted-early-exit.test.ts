import { describe, expect, it } from "vitest";
import { HttpClient } from "../../src/core/client.ts";
import { METRICS, type MetricsSink } from "../../src/core/metrics.ts";
import type { Result } from "../../src/core/types.ts";

/**
 * #196: a pre-aborted `signal` settles the ticket as cancelled before the
 * first attempt is prepared. Every early exit of that first attempt (bad URL,
 * bad body, bad options, open breaker, rate limit) used to emit "failure" for
 * a ticket whose Result was CancelledError. Now there is exactly one terminal
 * event, "cancelled", matching the Result.
 */

function setup(config: Partial<Parameters<typeof HttpClient.create>[0]> = {}) {
	const gauges: number[] = [];
	const metrics: MetricsSink = {
		counter: () => {},
		histogram: () => {},
		gauge: (name, value) => {
			if (name === METRICS.IN_FLIGHT) gauges.push(value);
		},
	};
	let fetches = 0;
	const client = HttpClient.create({
		timeout: { attemptMs: 5_000 },
		fetch: async () => {
			fetches++;
			return new Response("ok");
		},
		metrics,
		...config,
	});
	const events: string[] = [];
	for (const e of ["request", "success", "failure", "cancelled"] as const) client.on(e, () => events.push(e));
	return { client, events, gauges, fetches: () => fetches };
}

function aborted(): AbortSignal {
	const ac = new AbortController();
	ac.abort();
	return ac.signal;
}

function expectCancelled(result: Result<unknown>) {
	expect(result.success).toBe(false);
	if (!result.success) expect(result.error.kind).toBe("cancelled");
}

describe("pre-aborted signal on an early-exit request (#196)", () => {
	it("bad URL: one cancelled event, cancelled result", async () => {
		const { client, events, gauges, fetches } = setup();
		const result = await client.get("not-a-url", { signal: aborted() }).toPromise();
		expectCancelled(result);
		expect(events).toEqual(["cancelled"]);
		expect(gauges.at(-1)).toBe(0);
		expect(fetches()).toBe(0);
		await client.close();
	});

	it("invalid body: one cancelled event, cancelled result", async () => {
		const { client, events, gauges } = setup();
		const body = new ReadableStream();
		const result = await client.post("http://svc/a", body, { signal: aborted() }).toPromise();
		expectCancelled(result);
		expect(events).toEqual(["cancelled"]);
		expect(gauges.at(-1)).toBe(0);
		await client.close();
	});

	it("invalid options: one cancelled event, cancelled result", async () => {
		const { client, events, gauges } = setup();
		const result = await client.get("http://svc/a", { timeout: { attemptMs: -5 }, signal: aborted() }).toPromise();
		expectCancelled(result);
		expect(events).toEqual(["cancelled"]);
		expect(gauges.at(-1)).toBe(0);
		await client.close();
	});

	it("open breaker: one cancelled event, cancelled result, holds released", async () => {
		const { client, events, gauges } = setup({
			retry: { maxRetries: 0 },
			circuitBreaker: { enabled: true, failureThreshold: 1, resetTimeoutMs: 60_000 },
			fetch: async () => {
				throw new TypeError("fetch failed");
			},
		});
		const tripped = await client.get("http://svc/a").toPromise();
		expect(tripped.success).toBe(false);
		// Sanity: without the signal the breaker rejects the request.
		const rejected = await client.get("http://svc/a").toPromise();
		expect(!rejected.success && rejected.error.kind).toBe("circuit_open");

		events.length = 0;
		const result = await client.get("http://svc/a", { signal: aborted() }).toPromise();
		expectCancelled(result);
		expect(events).toEqual(["cancelled"]);
		expect(gauges.at(-1)).toBe(0);
		await client.close();
	});

	it("rate limited: one cancelled event, cancelled result", async () => {
		const { client, events, gauges } = setup({ rateLimit: { tokensPerSec: 1, burst: 1, maxWaitMs: 0 } });
		const first = await client.get("http://svc/a").toPromise();
		expect(first.success).toBe(true);
		const limited = await client.get("http://svc/a").toPromise();
		expect(!limited.success && limited.error.kind).toBe("rate_limited");

		events.length = 0;
		const result = await client.get("http://svc/a", { signal: aborted() }).toPromise();
		expectCancelled(result);
		expect(events).toEqual(["cancelled"]);
		expect(gauges.at(-1)).toBe(0);
		await client.close();
	});

	it("valid request: one cancelled event, no fetch", async () => {
		const { client, events, fetches } = setup();
		const result = await client.get("http://svc/a", { signal: aborted() }).toPromise();
		expectCancelled(result);
		expect(events).toEqual(["cancelled"]);
		expect(fetches()).toBe(0);
		await client.close();
	});

	it("without a pre-aborted signal an early exit still fails with its ConfigurationError", async () => {
		const { client, events } = setup();
		const result = await client.get("not-a-url").toPromise();
		expect(!result.success && result.error.kind).toBe("configuration");
		expect(events).toEqual(["failure"]);
		await client.close();
	});
});
