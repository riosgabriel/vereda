// Rate limiter demo model: one record per attempt, following the token bucket
// in src/queue/rate-limiter.ts. It runs in the page (for the sliders) and in
// test/demos/rate-limiter.parity.test.ts, which checks it against the real
// HttpClient. No DOM access here.

import { onMsGrid, toMs } from "../engine/time.js";

// ---- Simulation: one record per attempt, same bucket rules as rate-limiter.ts ----
export const END = 30;
export const API_LIMIT = 20;
const QUIET = 4;
const STEADY = 12;
const BURST_N = 100;
const BURST_AT = 6;
const BURST_END = 9;
const STEADY_TO = 22;
export const MAX_RETRIES = 3;

function rng(seed) {
	return () => {
		seed = (seed * 1664525 + 1013904223) >>> 0;
		return seed / 4294967296;
	};
}

// Mirror of TokenBucket (src/queue/rate-limiter.ts), in milliseconds.
class Bucket {
	constructor(rate, burst, maxWaitMs) {
		this.rate = rate;
		// Same default as TokenBucket: one second's worth, never below one token.
		this.burst = burst ?? Math.max(1, rate);
		this.maxWaitMs = maxWaitMs;
		this.tokens = this.burst;
		this.at = 0;
	}
	refill(now) {
		const el = now - this.at;
		if (el <= 0) return;
		this.tokens = Math.min(this.burst, this.tokens + (el / 1000) * this.rate);
		this.at = now;
	}
	nextWaitMs(now) {
		this.refill(now);
		return this.tokens >= 1 ? 0 : Math.ceil(((1 - this.tokens) / this.rate) * 1000);
	}
	reserve(now) {
		this.refill(now);
		if (this.tokens >= 1) {
			this.tokens -= 1;
			return 0;
		}
		const waitMs = Math.ceil(((1 - this.tokens) / this.rate) * 1000);
		if (this.maxWaitMs !== undefined && waitMs > this.maxWaitMs) return null;
		this.tokens -= 1;
		return waitMs;
	}
}

/** The traffic, shared with the parity test: submit times in seconds. */
function arrivals() {
	const rand = rng(5);
	const a = [];
	for (let i = 0; i < END * QUIET; i++) {
		const t = i / QUIET + 0.05 + rand() * 0.15;
		if (t < BURST_AT || t >= STEADY_TO) a.push(t);
	}
	for (let i = 0; i < BURST_N; i++) a.push(BURST_AT + i * 0.004 + rand() * 0.003);
	for (let i = 0; i < (STEADY_TO - BURST_END) * STEADY; i++) a.push(BURST_END + i / STEADY + rand() * 0.05);
	return a;
}
export const ARR = arrivals()
	.map(onMsGrid)
	.sort((x, y) => x - y);

/**
 * The API's rule, shared with the parity test: it counts attempts per calendar
 * second (of the moment the attempt arrives) and answers 429 once a second
 * has seen more than API_LIMIT. It sends no Retry-After header.
 */
export const apiAnswers = (countThisSecond) => countThisSecond <= API_LIMIT;

/** Runs one lane and returns one record per attempt, plus the bucket level after each reservation. */
export function runLane(limited, o) {
	const rand = rng(11);
	const count = {};
	const recs = [];
	const tokenLog = [];
	const q = [];
	const bucket = limited ? new Bucket(o.tokensPerSec, o.burst, o.maxWaitMs) : null;
	if (bucket) tokenLog.push({ t: 0, tokens: bucket.burst });
	let seq = 0;
	const push = (e) => {
		e.t = onMsGrid(e.t);
		e.seq = seq++;
		let i = q.length;
		while (i > 0 && q[i - 1].t > e.t) i--;
		q.splice(i, 0, e);
	};
	ARR.forEach((t, id) => {
		push({ type: "submit", t, id, retry: 0 });
	});
	while (q.length) {
		const e = q.shift();
		if (e.type === "submit") {
			if (!bucket) {
				push({ type: "arrive", t: e.t, sub: e.t, id: e.id, retry: e.retry, wait: 0 });
				continue;
			}
			const w = bucket.reserve(toMs(e.t));
			tokenLog.push({ t: e.t, tokens: bucket.tokens });
			if (w === null) {
				recs.push({
					id: e.id,
					t: e.t,
					start: null,
					end: e.t,
					kind: "limited",
					retry: e.retry,
					wait: 0,
					would: bucket.nextWaitMs(toMs(e.t)) / 1000,
					final: "fail",
				});
			} else {
				push({ type: "arrive", t: e.t + w / 1000, sub: e.t, id: e.id, retry: e.retry, wait: w / 1000 });
			}
		} else if (e.type === "answered") {
			// The client schedules its retry when the answer comes in, so two retries
			// due in the same millisecond go in order of their answers.
			push({ type: "submit", t: e.t + e.delay, id: e.id, retry: e.retry });
		} else {
			const sec = Math.floor(e.t);
			count[sec] = (count[sec] || 0) + 1;
			const ok = apiAnswers(count[sec]);
			const lat = onMsGrid(0.06 + rand() * 0.04);
			const rec = {
				id: e.id,
				t: e.sub,
				start: e.t,
				end: e.t + lat,
				kind: ok ? "ok" : "429",
				retry: e.retry,
				wait: e.wait,
				final: null,
			};
			if (!ok && o.retries && e.retry < MAX_RETRIES) {
				rec.delay = onMsGrid(0.3 + rand() * 0.2); // the retry's pause, not Vereda's backoff
				push({ type: "answered", t: rec.end, delay: rec.delay, id: e.id, retry: e.retry + 1 });
			} else rec.final = ok ? "ok" : "fail";
			recs.push(rec);
		}
	}
	recs.sort((x, y) => x.t - y.t);
	return { recs, tokenLog };
}

function toLane({ recs, tokenLog }, o, config) {
	const attempts = recs.map((r) => {
		const a = { request: r.id, n: r.retry, sent: r.t, start: r.start, end: r.end };
		if (r.kind === "limited") {
			a.outcome = "rejected";
			a.reason = "rate_limited";
			a.would = r.would; // how long it would have waited
		} else if (r.kind === "429") {
			a.outcome = "error";
			a.reason = "429";
		} else {
			a.outcome = "ok";
		}
		return a;
	});
	const results = recs
		.filter((r) => r.final !== null)
		.map((r) => ({
			request: r.id,
			t: r.end,
			ok: r.final === "ok",
			error: r.final === "ok" ? undefined : r.kind === "limited" ? "rate_limited" : o.retries ? "max_retries" : "429",
		}))
		.sort((x, y) => x.t - y.t);
	const lane = { config, attempts, results };
	if (tokenLog.length) lane.series = { tokens: tokenLog.map((e) => [e.t, e.tokens]) };
	return lane;
}

function phases(o) {
	return [
		{
			from: 0,
			to: BURST_AT,
			tone: "good",
			label: "Quiet · 4/s",
			caption: `Both clients send 4 requests per second. The API allows ${API_LIMIT} per second, so it answers every request. Before you press Play: 100 requests are about to arrive within 0.4 s. What will the API answer on each side?`,
		},
		{
			from: BURST_AT,
			to: BURST_END,
			tone: "bad",
			label: "Burst · 100",
			caption: `100 requests arrive within 0.4 s. On the left, they all reach the API, which answers 429 to everything above ${API_LIMIT} per second. On the right, the bucket lets ${o.tokensPerSec} requests per second through. The others wait in line${o.maxWaitMs === undefined ? "." : `, unless they would wait longer than ${o.maxWaitMs / 1000} s. Those fail at once.`}`,
		},
		{
			from: BURST_END,
			to: STEADY_TO,
			tone: "busy",
			label: "Steady · 12/s",
			caption:
				o.tokensPerSec > STEADY
					? `New requests arrive at ${STEADY} per second. On the left, the retries of the burst land on top of them. On the right, the bucket gives ${o.tokensPerSec} tokens per second, more than ${STEADY}, so the line gets shorter.`
					: `New requests arrive at ${STEADY} per second. On the left, the retries of the burst land on top of them. On the right, the bucket gives only ${o.tokensPerSec} tokens per second, so the line cannot get shorter.`,
		},
		{
			from: STEADY_TO,
			to: END,
			tone: "good",
			label: "Quiet · 4/s",
			caption:
				"Traffic is quiet again. Both sides send 4 requests per second and the API answers them. Compare how many requests succeeded on each side.",
		},
	];
}

/** Key events, found in the finished lanes. Nothing here is a hand-written time. */
function momentsOf(without, withB) {
	const m = [];
	const first429 = without.attempts.find((a) => a.outcome === "error");
	if (first429) m.push({ t: first429.end, label: "No limit: the API answers 429 for the first time" });
	const lastRetry = without.attempts.findLast((a) => a.n > 0);
	if (lastRetry) m.push({ t: lastRetry.sent, label: "No limit: the last retry goes out" });
	const waited = withB.attempts.filter((a) => a.start !== null && a.start - a.sent > 1e-9);
	if (waited.length) {
		m.push({ t: waited[0].sent, label: "Token bucket: no tokens left, so requests start to wait in line" });
		m.push({ t: waited[waited.length - 1].start, label: "Token bucket: the waiting line is empty" });
	}
	const limited = withB.attempts.find((a) => a.outcome === "rejected");
	if (limited)
		m.push({
			t: limited.end,
			label: "Token bucket: the first RateLimitedError. The wait would pass maxWaitMs, so nothing is sent",
		});
	const r429 = withB.attempts.find((a) => a.outcome === "error");
	if (r429) m.push({ t: r429.end, label: "Token bucket: the API answers 429 for the first time" });
	return m.sort((x, y) => x.t - y.t);
}

/** @returns {import("../engine/trace.js").DemoTrace} */
export function simulate(input) {
	const o = { ...input, burst: input.burst ?? Math.max(1, input.tokensPerSec) };
	const rl = o.maxWaitMs === undefined ? "" : `, maxWaitMs: ${o.maxWaitMs}`;
	const without = toLane(runLane(false, o), o, o.retries ? `retry: { maxRetries: ${MAX_RETRIES} }` : "retries: off");
	const withB = toLane(runLane(true, o), o, `rateLimit: { tokensPerSec: ${o.tokensPerSec}, burst: ${o.burst}${rl} }`);
	withB.bucket = { tokensPerSec: o.tokensPerSec, burst: o.burst, maxWaitMs: o.maxWaitMs };
	return {
		version: 1,
		pattern: "rate-limiter",
		duration: END,
		phases: phases(o),
		moments: momentsOf(without, withB),
		lanes: { without, with: withB },
	};
}
