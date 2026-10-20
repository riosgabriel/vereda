import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { admit, budgetStep, DT, FLOOR, RATE, simulate, WINDOW_TICKS } from "../../site/demos/models/retry-budget.js";
import { HttpClient } from "../../src/core/client.ts";
import { RetryBudget } from "../../src/queue/retry-budget.ts";

// The retry budget demo on the website is an aggregate (fluid) model: every
// 0.1 s tick it moves fractional amounts of traffic through an invented host.
// A per-request HttpClient run cannot reproduce that, so this test does NOT
// compare whole runs. It checks the one part that is Vereda's: the admission
// rule, `admit` in the model, which the page's run() calls on every tick.
//
// Verified here:
//  - the model's demand (first attempts and retries wanting to go, per tick),
//    scaled to whole requests, fed to the real RetryBudget, gets the same
//    admitted retries per tick as `admit` does (exact, every tick);
//  - the real HttpClient with a host that always answers 503 admits the number
//    of retries `admit` predicts.
//
// NOT verified (invented for the demo, nothing in the library): the host's
// capacity (120/s, 60/s during the outage), the overload collapse down to 30%,
// the 5% random failures, the 0.3 s retry delay, and the fluid fractions. The
// page's load, success and refusal curves depend on them; only the admission
// rule behind the refusals is checked.
//
// Known, deliberate gaps between model and library:
//  - Fractions: the model admits `min(want, room)` of a fractional stream; the
//    library admits whole retries while retries < allowed (strict `<`), which
//    is `ceil(room)` when room is the limit. Scaled to whole requests the two
//    agree once the model's number is rounded up.
//  - Bucket timing: the library keeps buckets whose start is >= now - windowMs.
//    With `now` mid-bucket that is 10 buckets, like the model. Exactly on a
//    bucket boundary it is 11 buckets (1.1 s), see the second block below.
//  - Order inside a tick: the model counts the whole tick's first attempts
//    before any retry asks. Real traffic interleaves them, so a retry early in
//    a tick sees slightly fewer requests. The test uses the model's order.

const SCALE = 100;
const WINDOW_MS = 1000;
const TICK_MS = DT * 1000;
const TICKS = 400;

type Tick = { t: number; first: number; want: number };
type Case = { ratio: number; maxRetries: number };

const cases: Case[] = [
	{ ratio: 0.1, maxRetries: 3 },
	{ ratio: 0.05, maxRetries: 1 },
	{ ratio: 0.3, maxRetries: 5 },
	{ ratio: 0.5, maxRetries: 2 },
];

/** The model's demand per tick in the budget lane, scaled to whole requests. */
function demandOf(c: Case): Tick[] {
	const series = simulate(c).lanes.with.series;
	if (!series) throw new Error("the model has no series");
	return series.load.slice(0, TICKS).map(([t], i) => {
		const retries = series.retries[i][1] * DT; // admitted
		const refused = series.refused[i][1] * DT;
		return { t, first: Math.round(RATE * DT * SCALE), want: Math.round((retries + refused) * SCALE) };
	});
}

/** Retries the real RetryBudget admits per tick; `offsetMs` places `now` inside the bucket. */
function realAdmitted(c: Case, demand: Tick[], offsetMs: number): number[] {
	const budget = new RetryBudget({ ratio: c.ratio, windowMs: WINDOW_MS, minRetriesPerSec: FLOOR * SCALE });
	return demand.map((d, i) => {
		const now = i * TICK_MS + offsetMs;
		for (let k = 0; k < d.first; k++) budget.recordRequest(now);
		let admitted = 0;
		for (let k = 0; k < d.want; k++) if (budget.tryWithdraw(now)) admitted++;
		return admitted;
	});
}

/** Retries the model's budget step lets through per tick, counted in whole requests. */
function modelAdmitted(c: Case, demand: Tick[], windowTicks: number): number[] {
	const win: Array<{ req: number; ret: number }> = [];
	return demand.map((d) =>
		budgetStep(win, { first: d.first, want: d.want, ratio: c.ratio, floor: FLOOR * SCALE }, true, windowTicks),
	);
}

describe("retry budget demo: admission rule matches the real RetryBudget", () => {
	for (const c of cases) {
		const label = `ratio ${c.ratio}, maxRetries ${c.maxRetries}`;

		it(`${label}: admitted retries per tick are identical (now mid-bucket)`, () => {
			const demand = demandOf(c);
			// The stream must exercise the rule: retries both admitted and refused.
			expect(demand.some((d) => d.want > 0)).toBe(true);
			const model = modelAdmitted(c, demand, WINDOW_TICKS);
			expect(model.some((n, i) => n > 0 && n < demand[i].want)).toBe(true);
			expect(realAdmitted(c, demand, TICK_MS / 2)).toEqual(model);
		});

		it(`${label}: exactly on a bucket boundary the library window holds 11 buckets`, () => {
			const demand = demandOf(c);
			expect(realAdmitted(c, demand, 0)).toEqual(modelAdmitted(c, demand, WINDOW_TICKS + 1));
		});
	}
});

describe("retry budget demo rule vs the real HttpClient", () => {
	beforeEach(() => {
		vi.useFakeTimers({ now: 0 });
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	for (const ratio of [0.1, 0.25]) {
		it(`a host that always answers 503, ratio ${ratio}: retries admitted match the rule`, async () => {
			const requests = 400;
			let calls = 0;
			let exhausted = 0;
			const client = HttpClient.create({
				timeout: { attemptMs: 1000 },
				// Room for every request at once: the rule, not a queue, decides.
				concurrency: requests,
				maxQueueSize: requests,
				defaultPartition: { concurrency: requests, maxQueueSize: requests },
				retry: { maxRetries: 3, backoff: { baseDelayMs: 1, maxDelayMs: 1, jitter: false } },
				retryBudget: { ratio, windowMs: WINDOW_MS, minRetriesPerSec: 1 },
				fetch: async () => {
					calls++;
					return new Response("busy", { status: 503 });
				},
			});
			client.on("retryBudgetExhausted", () => exhausted++);

			// All requests land inside one window, so the window never ages out.
			const done: Promise<unknown>[] = [];
			for (let i = 0; i < requests; i++) {
				done.push(
					client
						.get(`http://host.test/r/${i}`)
						.toPromise()
						.catch(() => undefined),
				);
			}
			await vi.advanceTimersByTimeAsync(500);
			await Promise.all(done);
			await client.close();

			const retries = calls - requests;
			// Whole requests: the rule's limit is max(1, ratio x requests); retries stop at it.
			const predicted = admit({ requests, retries: 0, ratio, floor: 1, want: Infinity, whole: true });
			expect(retries).toBe(predicted);
			// 3 retries per request were wanted; every one beyond the budget was refused.
			expect(exhausted).toBeGreaterThan(0);
		});
	}
});
