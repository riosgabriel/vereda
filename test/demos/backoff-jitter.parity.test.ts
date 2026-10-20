import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { firstAttempts, jitterSequence, makeHost, simulate } from "../../site/demos/models/backoff-jitter.js";
import { HttpClient } from "../../src/core/client.ts";

// The backoff + jitter demo on the website runs a hand-written model so its
// sliders can re-run instantly. This test keeps that model honest: it sends the
// demo's clients through the real HttpClient under fake timers, against the
// demo's host (down until 1 s, then `capacity` requests per second, the rest
// refused at once with a 503), and checks that every attempt happens when the
// model says. If the library's backoff or retry loop changes, this fails until
// the demo is updated.

type Options = { clients: number; base: number; maxRetries: number; maxDelay: number; capacity: number };
type Attempt = { c: number; k: number; t: number; result: string };
type Run = { attempts: Attempt[]; served: number; doneAt: number };

const DEFAULTS: Options = { clients: 100, base: 200, maxRetries: 5, maxDelay: 30, capacity: 40 };

/** Attempts of one lane from the real client. */
async function runReal(jitter: boolean, o: Options): Promise<Run> {
	const host = makeHost(o.capacity);
	const attempts: Attempt[] = [];
	const count = new Map<number, number>();
	// Vereda's full jitter calls Math.random() once per retry, when the failure
	// is known: the same order as the model, so one seeded sequence serves both.
	const seq = jitterSequence();
	const random = vi.spyOn(Math, "random").mockImplementation(() => seq());

	const client = HttpClient.create({
		timeout: { attemptMs: 60_000 },
		retry: {
			maxRetries: o.maxRetries,
			backoff: { baseDelayMs: o.base, maxDelayMs: o.maxDelay * 1000, jitter },
		},
		// Isolate backoff: no bulkhead may ever queue a retry. Defaults are 50
		// global permits and 5 partition slots for retries; with 200 clients
		// retrying at once that would add queueing delay the model doesn't have.
		// The breaker, rate limit and retry budget are off unless configured.
		concurrency: 10_000,
		maxQueueSize: 10_000,
		defaultPartition: { concurrency: 10_000, maxQueueSize: 10_000 },
		fetch: async (input) => {
			const id = Number(new URL(String(input)).pathname.split("/").pop());
			const t = Date.now();
			const result = host(t);
			count.set(id, (count.get(id) ?? -1) + 1);
			attempts.push({ c: id, k: count.get(id) as number, t: t / 1000, result });
			return new Response(result === "ok" ? "ok" : "no", { status: result === "ok" ? 200 : 503 });
		},
	});

	const finished = new Map<number, number>();
	firstAttempts(o.clients).forEach((t, c) => {
		setTimeout(() => {
			void client
				.get(`http://host.test/c/${c}`)
				.toPromise()
				.catch(() => undefined)
				.then(() => finished.set(c, Date.now() / 1000));
		}, t);
	});
	await vi.advanceTimersByTimeAsync(400_000);
	await client.close();
	random.mockRestore();
	expect(finished.size).toBe(o.clients);
	return {
		attempts,
		served: attempts.filter((a) => a.result === "ok").length,
		doneAt: Math.max(...finished.values()),
	};
}

function modelRun(jitter: boolean, o: Options): Run {
	const trace = simulate(o);
	const lane = jitter ? trace.lanes.with : trace.lanes.without;
	const attempts: Attempt[] = lane.attempts.map(
		(a: { request: number; n: number; sent: number; outcome: string; reason?: string }) => ({
			c: a.request,
			k: a.n,
			t: a.sent,
			result: a.outcome === "ok" ? "ok" : a.reason === "host_down" ? "down" : "over",
		}),
	);
	return {
		attempts,
		served: lane.results.filter((r: { ok: boolean }) => r.ok).length,
		doneAt: Math.max(...lane.results.map((r: { t: number }) => r.t)),
	};
}

/** One client's attempts, in order: [n, seconds, outcome]. */
const byClient = (run: Run, c: number) =>
	run.attempts.filter((a) => a.c === c).map((a) => [a.k, a.t, a.result] as const);

describe("backoff + jitter demo model matches the real HttpClient", () => {
	beforeEach(() => {
		vi.useFakeTimers({ now: 0 });
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	const cases: Array<[string, Options]> = [
		["defaults", DEFAULTS],
		["20 clients", { ...DEFAULTS, clients: 20 }],
		["200 clients", { ...DEFAULTS, clients: 200 }],
		["baseDelayMs 50", { ...DEFAULTS, base: 50 }],
		["baseDelayMs 500", { ...DEFAULTS, base: 500 }],
		["maxRetries 1", { ...DEFAULTS, maxRetries: 1 }],
		["maxRetries 6", { ...DEFAULTS, maxRetries: 6 }],
		["maxDelayMs 1 s", { ...DEFAULTS, maxDelay: 1 }],
		["capacity 20/s", { ...DEFAULTS, capacity: 20 }],
		["capacity 100/s", { ...DEFAULTS, capacity: 100 }],
	];

	for (const jitter of [false, true]) {
		for (const [name, o] of cases) {
			it(`${name}, jitter ${jitter}`, async () => {
				const real = await runReal(jitter, o);
				const model = modelRun(jitter, o);
				expect(real.served).toBe(model.served);
				for (let c = 0; c < o.clients; c++) {
					const r = byClient(real, c);
					const m = byClient(model, c);
					expect(r.map(([k, , res]) => [k, res])).toEqual(m.map(([k, , res]) => [k, res]));
					r.forEach(([, t], i) => {
						// Timers fire on whole milliseconds; the model uses exact seconds.
						expect(t).toBeCloseTo(m[i][1], 2);
					});
				}
				expect(real.doneAt).toBeCloseTo(model.doneAt, 2);
			});
		}
	}
});
