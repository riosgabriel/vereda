import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ARR, apiAnswers, END, MAX_RETRIES, runLane } from "../../site/demos/models/rate-limiter.js";
import { HttpClient } from "../../src/core/client.ts";
import { RateLimitedError } from "../../src/core/errors.ts";

// The rate limiter demo on the website runs a hand-written model of the token
// bucket so its sliders can re-run instantly. This test keeps that model
// honest: it sends the demo's exact traffic through the real HttpClient, under
// fake timers, against a fake API that plays the demo's API, and compares every
// attempt (which one goes out, when, and how the API answers) with the model.
// If the library's rate limiter changes, this fails until the demo is updated.
//
// The demo's API is not asked about Retry-After: it never sends the header, so
// the client's own backoff function is the only source of retry delays.

type Options = { tokensPerSec: number; burst: number | undefined; maxWaitMs: number | undefined; retries: boolean };
type Kind = "ok" | "429" | "limited";
type Seen = { kind: Kind; t: number; wait: number };

const key = (id: number, n: number) => `${id}:${n}`;

/**
 * Sends the demo's traffic through the real client. Returns, per attempt
 * (`request:retry`), what happened and when (seconds), plus the token wait.
 */
async function runReal(o: Options): Promise<Map<string, Seen>> {
	// The model decides each attempt's API latency and each retry's pause (both
	// come from its seeded generator, in its own event order). The fake API and
	// the backoff below replay those numbers by (request, retry), so the model
	// and the library see identical conditions.
	const model = runLane(true, o).recs as Array<{
		id: number;
		retry: number;
		kind: string;
		start: number | null;
		end: number;
		delay?: number;
	}>;
	const latencyOf = new Map<string, number>();
	const delayOf = new Map<string, number>();
	for (const r of model) {
		if (r.start !== null) latencyOf.set(key(r.id, r.retry), r.end - r.start);
		if (r.delay !== undefined) delayOf.set(key(r.id, r.retry), r.delay);
	}

	const seen = new Map<string, Seen>();
	const calls = new Map<number, number>(); // fetches so far per request
	const sentAt = new Map<string, number>(); // when each attempt asked for its token
	const answeredAt = new Map<string, number>();
	const perSecond = new Map<number, number>();
	let lastAnswered = -1; // request whose answer the client is handling now

	// The partition and global concurrency are set far above the demo's 297 or
	// 532 attempts, and so are both queue sizes, so no bulkhead or semaphore
	// ever makes an attempt wait. By default retries share 5 partition slots and
	// 50 global permits, which would add waiting on top of the token wait.
	const big = 1_000_000;
	const client = HttpClient.create({
		timeout: { attemptMs: 60_000 },
		retry: {
			maxRetries: o.retries ? MAX_RETRIES : 0,
			// Called with the zero-based retry number right after attempt `attempt`
			// of request `lastAnswered` failed; no other answer can be handled
			// in between, because the fake clock only moves between timers.
			backoff: (attempt) => Math.round((delayOf.get(key(lastAnswered, attempt)) ?? Number.NaN) * 1000),
		},
		concurrency: big,
		maxQueueSize: big,
		defaultPartition: { concurrency: big, maxQueueSize: big },
		rateLimit: { tokensPerSec: o.tokensPerSec, burst: o.burst, maxWaitMs: o.maxWaitMs },
		fetch: (input) => {
			const id = Number(new URL(String(input)).pathname.split("/").pop());
			const n = calls.get(id) ?? 0;
			calls.set(id, n + 1);
			const now = Date.now();
			// The API counts attempts per calendar second of their arrival.
			const sec = Math.floor(now / 1000);
			const count = (perSecond.get(sec) ?? 0) + 1;
			perSecond.set(sec, count);
			const ok = apiAnswers(count);
			const sent = sentAt.get(key(id, n)) ?? Number.NaN;
			seen.set(key(id, n), { kind: ok ? "ok" : "429", t: now / 1000, wait: now / 1000 - sent });
			const lat = latencyOf.get(key(id, n)) ?? Number.NaN;
			return new Promise<Response>((resolve) => {
				setTimeout(
					() => {
						lastAnswered = id;
						answeredAt.set(key(id, n), Date.now() / 1000);
						resolve(new Response(ok ? "ok" : "busy", { status: ok ? 200 : 429 }));
					},
					Math.round(lat * 1000),
				);
			});
		},
	});
	client.on("failure", (e) => {
		if (!(e.error instanceof RateLimitedError)) return;
		const id = Number(new URL(e.url).pathname.split("/").pop());
		const n = calls.get(id) ?? 0; // fetches made = this attempt's retry number
		const t = Date.now() / 1000;
		seen.set(key(id, n), { kind: "limited", t, wait: 0 });
	});

	ARR.forEach((at: number, id: number) => {
		setTimeout(
			() => {
				sentAt.set(key(id, 0), Date.now() / 1000);
				void client.get(`http://api.test/r/${id}`).toPromise();
			},
			Math.round(at * 1000),
		);
	});
	await vi.advanceTimersByTimeAsync((END + 200) * 1000);
	await client.close();

	// A retry asks for its token when its pause ends, so its wait is measured
	// from there. Fill in `wait` for retries now that every answer is known.
	for (const [k, s] of seen) {
		const [id, n] = k.split(":").map(Number);
		if (n > 0 && s.kind !== "limited") {
			const sent = (answeredAt.get(key(id, n - 1)) ?? Number.NaN) + (delayOf.get(key(id, n - 1)) ?? Number.NaN);
			s.wait = s.t - sent;
		}
	}
	return seen;
}

function runModel(o: Options): Map<string, Seen> {
	const out = new Map<string, Seen>();
	for (const r of runLane(true, o).recs as Array<{
		id: number;
		retry: number;
		kind: string;
		t: number;
		start: number | null;
	}>) {
		if (r.kind === "limited") out.set(key(r.id, r.retry), { kind: "limited", t: r.t, wait: 0 });
		else out.set(key(r.id, r.retry), { kind: r.kind as Kind, t: r.start as number, wait: (r.start as number) - r.t });
	}
	return out;
}

const describeCase = (o: Options) =>
	`rate ${o.tokensPerSec}, burst ${o.burst ?? "default"}, maxWait ${o.maxWaitMs ?? "none"}, retries ${o.retries ? "on" : "off"}`;

async function expectSame(o: Options): Promise<void> {
	const real = await runReal(o);
	const model = runModel(o);
	// Same attempts, same fate for each: sent and answered, 429, or RateLimitedError.
	const fates = (m: Map<string, Seen>) =>
		[...m].map(([k, s]) => `${k} ${s.kind}`).sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
	expect(fates(real)).toEqual(fates(model));
	let mismatches = 0;
	for (const [k, m] of model) {
		const r = real.get(k) as Seen;
		// Timers fire on whole milliseconds; the model uses exact seconds.
		if (Math.abs(r.t - m.t) > 0.01 || Math.abs(r.wait - m.wait) > 0.01) {
			mismatches++;
			if (mismatches <= 5) expect({ k, t: r.t, wait: r.wait }).toEqual({ k, t: m.t, wait: m.wait });
		}
	}
	expect(mismatches).toBe(0);
}

describe("rate limiter demo model matches the real HttpClient", () => {
	beforeEach(() => {
		vi.useFakeTimers({ now: 0 });
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	// Retries off: the model's own retry pause is not Vereda's backoff, but with
	// no retries every attempt is a first attempt and the comparison is exact.
	const grid: Options[] = [];
	for (const tokensPerSec of [5, 15, 30])
		for (const burst of [1, 5, 40])
			for (const maxWaitMs of [500, 5000, undefined]) grid.push({ tokensPerSec, burst, maxWaitMs, retries: false });
	grid.push({ tokensPerSec: 5, burst: undefined, maxWaitMs: 5000, retries: false });
	grid.push({ tokensPerSec: 15, burst: undefined, maxWaitMs: undefined, retries: false });

	for (const o of grid) it(describeCase(o), () => expectSame(o));

	// Retries on: the backoff function replays the model's pause for each retry
	// (see runReal), so the comparison stays exact, including retries that fail
	// with RateLimitedError when their token is too far off.
	const withRetries: Options[] = [
		{ tokensPerSec: 15, burst: 5, maxWaitMs: 5000, retries: true },
		{ tokensPerSec: 5, burst: 1, maxWaitMs: 500, retries: true },
		{ tokensPerSec: 30, burst: 40, maxWaitMs: undefined, retries: true },
		{ tokensPerSec: 15, burst: 40, maxWaitMs: 2000, retries: true },
		{ tokensPerSec: 5, burst: 5, maxWaitMs: undefined, retries: true },
	];
	for (const o of withRetries) it(describeCase(o), () => expectSame(o));
});
