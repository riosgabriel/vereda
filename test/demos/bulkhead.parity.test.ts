import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { arrivalsFor, END, GQ, hostAnswer, PQ, simulate, TIMEOUT } from "../../site/demos/models/bulkhead.js";
import { HttpClient } from "../../src/core/client.ts";
import { QueueFullError } from "../../src/core/errors.ts";

// The bulkhead demo on the website runs a hand-written model so its sliders can
// re-run instantly. This test keeps that model honest: it sends the demo's exact
// traffic through the real HttpClient, under fake timers, once with only the
// global limit and once with a search partition, and checks every request
// against the model: when it started, when it settled, and whether (and where)
// a full queue rejected it. If the library's queues change, this fails until
// the demo is updated.

type Options = { slow: number; G: number; C: number };
type Outcome = { start: number | null; end: number; rejected: "global" | "partition" | null };

/** What the real client did with each request, indexed by request id. */
async function runReal(o: Options, bulk: boolean): Promise<Outcome[]> {
	const arrivals = arrivalsFor(o);
	const outcomes: Outcome[] = arrivals.map(() => ({ start: null, end: Number.NaN, rejected: null }));
	const client = HttpClient.create({
		concurrency: o.G,
		maxQueueSize: GQ,
		retry: { maxRetries: 0 },
		timeout: { attemptMs: TIMEOUT * 1000 },
		...(bulk ? { partitions: { search: { concurrency: o.C, maxQueueSize: PQ, limitFirstAttempts: true } } } : {}),
		// The demo's host: answers after its latency, or hangs until the attempt
		// timeout aborts it.
		fetch: (input, init) => {
			const id = Number(new URL(String(input)).pathname.split("/").pop());
			const now = Date.now() / 1000;
			outcomes[id].start = now;
			const answer = hostAnswer(o, arrivals[id], now);
			return new Promise<Response>((resolve, reject) => {
				init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
				if (answer.kind === "ok") setTimeout(() => resolve(new Response("ok")), answer.dur * 1000);
			});
		},
	});

	for (const a of arrivals) {
		setTimeout(() => {
			const partition = a.part === "pay" ? "payments" : "search";
			const ticket = client.get(`http://${partition}.test/r/${a.id}`, { partition });
			// A failed ticket still resolves: toPromise() carries the error in its Result.
			void ticket.toPromise().then((result) => {
				outcomes[a.id].end = Date.now() / 1000;
				if (!result.success && result.error instanceof QueueFullError) outcomes[a.id].rejected = result.error.scope;
			});
		}, a.t * 1000);
	}
	await vi.advanceTimersByTimeAsync((END + 2) * 1000);
	await client.close();
	return outcomes;
}

/** The model's view of the same requests. */
function runModel(o: Options, bulk: boolean): Outcome[] {
	const lane = simulate(o).lanes[bulk ? "with" : "without"];
	return lane.attempts.map((a: { start: number | null; end: number; reason?: string }) => ({
		start: a.start,
		end: a.end,
		rejected: a.reason === undefined ? null : (a.reason.split(":")[1] as "global" | "partition"),
	}));
}

describe("bulkhead demo model matches the real HttpClient", () => {
	beforeEach(() => {
		vi.useFakeTimers({ now: 0 });
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	const cases: Options[] = [
		{ slow: 4, G: 8, C: 3 },
		{ slow: 8, G: 8, C: 3 }, // search times out at 6 s
		{ slow: 4, G: 4, C: 1 },
		{ slow: 4, G: 12, C: 6 },
	];

	for (const o of cases) {
		for (const bulk of [false, true]) {
			it(`slow ${o.slow} s, ${o.G} global permits, ${o.C} search slots, ${bulk ? "with partition" : "global only"}`, async () => {
				const real = await runReal(o, bulk);
				const model = runModel(o, bulk);
				expect(real.length).toBe(model.length);
				model.forEach((m, id) => {
					const r = real[id];
					expect(r.rejected, `request ${id} rejection`).toBe(m.rejected);
					// Timers fire on whole milliseconds; the model uses exact seconds.
					if (m.start === null) expect(r.start, `request ${id} start`).toBeNull();
					else expect(r.start, `request ${id} start`).toBeCloseTo(m.start, 2);
					expect(r.end, `request ${id} end`).toBeCloseTo(m.end, 2);
				});
			});
		}
	}
});
