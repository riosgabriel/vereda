import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpClient } from "../../src/core/client.ts";
import { json } from "../../src/core/index.ts";
import { METRICS, type MetricsSink } from "../../src/core/metrics.ts";
import type { Result } from "../../src/core/types.ts";

/**
 * T3 (#135): the lifecycle invariant behind B1–B9, checked over random
 * scenarios instead of one hand-written test per bug.
 *
 * For every ticket, whatever happens (server answers, timeouts, deadlines,
 * cancel at a random moment, throwing listeners and metrics sinks, close()
 * mid-flight):
 *   1. `toPromise()` settles;
 *   2. exactly one of `success`/`failure`/`cancelled` fires, and it agrees
 *      with the ticket's Result;
 * and once everything settles:
 *   3. no partition has running or queued work;
 *   4. the last `in_flight` gauge is 0.
 *
 * Runs `VEREDA_FC_RUNS` scenarios (default 100, about 4s). For a deep
 * local run: `VEREDA_FC_RUNS=500 npx vitest run lifecycle-invariants`. A
 * failure prints a seed and a shrunk scenario; replay it with
 * `fc.assert(..., { seed, path })`.
 */

const NUM_RUNS = Number(process.env.VEREDA_FC_RUNS ?? 100);

// ---------------------------------------------------------------------------
// Fake transport: each attempt for a URL plays the next scripted behavior.
// Every behavior honors the abort signal, like undici does.
// ---------------------------------------------------------------------------

type Behavior = "ok" | "not_found" | "busy" | "network" | "hang" | "malformed" | "stall_body";

const BEHAVIORS: Behavior[] = ["ok", "not_found", "busy", "network", "hang", "malformed", "stall_body"];

function abortable<T>(signal: AbortSignal | null | undefined, delayMs: number, value: () => T): Promise<T> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) return reject(signal.reason);
		const timer = setTimeout(() => resolve(value()), delayMs);
		signal?.addEventListener(
			"abort",
			() => {
				clearTimeout(timer);
				reject(signal.reason);
			},
			{ once: true },
		);
	});
}

function stallingBody(signal: AbortSignal | null | undefined): ReadableStream<Uint8Array> {
	return new ReadableStream({
		start(controller) {
			controller.enqueue(new TextEncoder().encode("["));
			signal?.addEventListener("abort", () => controller.error(signal.reason), { once: true });
		},
	});
}

function respond(behavior: Behavior, signal: AbortSignal | null | undefined): Response | Promise<never> {
	switch (behavior) {
		case "ok":
			return new Response('{"ok":true}', { status: 200, headers: { "content-type": "application/json" } });
		case "not_found":
			return new Response("nope", { status: 404 });
		case "busy":
			return new Response("busy", { status: 503, headers: { "retry-after": "0" } });
		case "malformed":
			return new Response("<html>", { status: 200 });
		case "stall_body":
			return new Response(stallingBody(signal), { status: 200 });
		case "network":
			return Promise.reject(new TypeError("fetch failed"));
		case "hang":
			return new Promise<never>((_, reject) => {
				signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
			});
	}
}

function scriptedFetch(scripts: Map<string, { behaviors: Behavior[]; delayMs: number }>): typeof fetch {
	const attempts = new Map<string, number>();
	return async (input, init) => {
		const url = String(input);
		const script = scripts.get(url);
		if (!script) throw new Error(`unscripted URL ${url}`);
		const n = attempts.get(url) ?? 0;
		attempts.set(url, n + 1);
		// Past the end of the script, repeat the last behavior.
		const behavior = script.behaviors[Math.min(n, script.behaviors.length - 1)];
		if (behavior === "hang" || behavior === "network") return respond(behavior, init?.signal);
		return abortable(init?.signal, script.delayMs, () => respond(behavior, init?.signal)).then((r) => r);
	};
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

const ticketArb = fc.record({
	behaviors: fc.array(fc.constantFrom(...BEHAVIORS), { minLength: 1, maxLength: 3 }),
	delayMs: fc.integer({ min: 0, max: 20 }),
	parse: fc.boolean(),
	method: fc.constantFrom("GET", "POST"),
	cancelAtMs: fc.option(fc.integer({ min: 0, max: 60 }), { nil: undefined }),
	throwingDoneListener: fc.boolean(),
});

const scenarioArb = fc
	.record({
		tickets: fc.array(ticketArb, { minLength: 1, maxLength: 4 }),
		maxRetries: fc.integer({ min: 0, max: 2 }),
		attemptMs: fc.option(fc.integer({ min: 10, max: 60 }), { nil: undefined }),
		totalMs: fc.option(fc.integer({ min: 20, max: 150 }), { nil: undefined }),
		partitionConcurrency: fc.integer({ min: 1, max: 3 }),
		limitFirstAttempts: fc.boolean(),
		throwingClientListener: fc.boolean(),
		throwingSink: fc.boolean(),
		close: fc.option(
			fc.record({
				atMs: fc.integer({ min: 0, max: 80 }),
				drain: fc.boolean(),
				timeoutMs: fc.integer({ min: 1, max: 40 }),
			}),
			{ nil: undefined },
		),
	})
	// "hang" with no attempt timeout and no deadline legitimately never settles.
	.filter((s) => s.attemptMs !== undefined || s.totalMs !== undefined);

type Scenario = typeof scenarioArb extends fc.Arbitrary<infer S> ? S : never;

const TERMINAL = ["success", "failure", "cancelled"] as const;
type Terminal = (typeof TERMINAL)[number];

function expectedTerminal(result: Result<unknown>): { event: Terminal; kind?: string } {
	if (result.success) return { event: "success" };
	if (result.error.kind === "cancelled") return { event: "cancelled" };
	return { event: "failure", kind: result.error.kind };
}

// reportCallbackError rethrows user-callback errors on a microtask so they
// reach uncaughtException; capture them instead (as callback-isolation.test.ts does).
let reported: unknown[];
beforeEach(() => {
	reported = [];
	vi.stubGlobal("queueMicrotask", (fn: () => void) => {
		try {
			fn();
		} catch (err) {
			reported.push(err);
		}
	});
});
afterEach(() => {
	vi.unstubAllGlobals();
});

const listenerBug = new Error("listener bug");
const sinkBug = new Error("sink bug");

async function runScenario(s: Scenario): Promise<void> {
	const scripts = new Map(
		s.tickets.map((t, i) => [`http://svc/t${i}`, { behaviors: t.behaviors, delayMs: t.delayMs }]),
	);

	const gauges: number[] = [];
	const sink: MetricsSink = {
		counter: () => {
			if (s.throwingSink) throw sinkBug;
		},
		histogram: () => {
			if (s.throwingSink) throw sinkBug;
		},
		gauge: (name, value) => {
			if (name === METRICS.IN_FLIGHT) gauges.push(value);
			if (s.throwingSink) throw sinkBug;
		},
	};

	const client = HttpClient.create({
		fetch: scriptedFetch(scripts),
		metrics: sink,
		retry: { maxRetries: s.maxRetries, backoff: { baseDelayMs: 1, maxDelayMs: 2, jitter: false } },
		timeout: { attemptMs: s.attemptMs ?? Number.POSITIVE_INFINITY, totalMs: s.totalMs },
		partitions: { svc: { concurrency: s.partitionConcurrency, limitFirstAttempts: s.limitFirstAttempts } },
	});

	const events = new Map<string, { event: Terminal; kind?: string }[]>();
	for (const event of TERMINAL) {
		client.on(event, (data) => {
			const list = events.get(data.ticketId) ?? [];
			list.push({ event, kind: "error" in data ? data.error.kind : undefined });
			events.set(data.ticketId, list);
			if (s.throwingClientListener) throw listenerBug;
		});
	}

	const tickets = s.tickets.map((t, i) => {
		const ticket = client.request(`http://svc/t${i}`, {
			method: t.method,
			partition: "svc",
			...(t.parse ? { parse: json() } : {}),
		});
		if (t.throwingDoneListener) {
			ticket.on("done", () => {
				throw listenerBug;
			});
		}
		if (t.cancelAtMs !== undefined) setTimeout(() => ticket.cancel(), t.cancelAtMs);
		return ticket;
	});

	let closing: Promise<void> | undefined;
	if (s.close) {
		const { atMs, drain, timeoutMs } = s.close;
		setTimeout(() => {
			closing = client.close(drain ? { drain, timeoutMs } : undefined);
		}, atMs);
	}

	// 1. Every ticket settles (bounded by attemptMs/totalMs/cancel/close).
	const results = await Promise.all(
		tickets.map((t) =>
			Promise.race([
				t.toPromise(),
				new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`ticket ${t.id} never settled`)), 3_000)),
			]),
		),
	);

	// Terminal events and cleanup can trail toPromise() by a tick (e.g. an
	// attempt still unwinding after cancel()), so wait for them to land.
	await vi.waitFor(
		() => {
			for (const t of tickets) expect(events.get(t.id)?.length ?? 0).toBeGreaterThan(0);
			for (const p of client.partitions()) expect([p.name, p.running, p.queued]).toEqual([p.name, 0, 0]);
		},
		{ timeout: 2_000, interval: 5 },
	);
	// ...and give any duplicate event a chance to show up.
	await new Promise((r) => setTimeout(r, 20));
	await closing;

	// 2. Exactly one terminal event per ticket, matching its Result.
	tickets.forEach((t, i) => {
		expect(events.get(t.id), `ticket ${i} terminal events`).toEqual([expectedTerminal(results[i])]);
	});

	// 3. Nothing left running or queued.
	for (const p of client.partitions()) expect(p.running + p.queued, `partition ${p.name}`).toBe(0);

	// 4. The in_flight gauge returns to 0.
	expect(gauges.at(-1)).toBe(0);

	// Only the errors we planted reached reportCallbackError.
	for (const err of reported) expect([listenerBug, sinkBug]).toContain(err);

	await client.close();
}

describe("lifecycle invariants under random scenarios (T3, #135)", () => {
	it("every ticket settles with exactly one matching terminal event and releases its resources", async () => {
		await fc.assert(
			fc.asyncProperty(scenarioArb, async (s) => {
				reported = [];
				await runScenario(s);
			}),
			{ numRuns: NUM_RUNS },
		);
	}, 120_000);
});
