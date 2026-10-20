// Circuit breaker demo model: one record per request, following the state
// machine in src/queue/circuit-breaker.ts. It runs in the page (for the
// sliders) and in test/demos/circuit-breaker.parity.test.ts, which checks its
// state changes against the real HttpClient. No DOM access here.

import { toMs } from "../engine/time.js";

// ---- Simulation: one record per request, same rules as circuit-breaker.ts ----
export const END = 32;
export const RATE = 10;
export const TIMEOUT = 1.0;
const OK_LAT = 0.1;
export const BAD_FROM = 6;
export const BAD_TO = 20;
export const WINDOW_SEC = 3;
export const MIN_REQ = 10;
export const PCT = 30;

function rng(seed) {
	return () => {
		seed = (seed * 1664525 + 1013904223) >>> 0;
		return seed / 4294967296;
	};
}
export const isBad = (t) => t >= BAD_FROM && t < BAD_TO;

/**
 * The traffic and the host's behaviour, shared by the model and the parity
 * test so both see exactly the same requests. `lat` is how long the host takes
 * to answer; a failing request never answers and is cut by the 1 s timeout.
 */
export function arrivalsFor(o) {
	const rand = rng(42);
	const arrivals = [];
	for (let i = 0; i < END * RATE; i++) {
		const t = i / RATE + 0.02 + rand() * 0.04;
		const fails = isBad(t) && (o.scenario === "down" || rand() < 0.4);
		arrivals.push({ id: i, t, fails, lat: fails ? TIMEOUT : OK_LAT + rand() * 0.05 });
	}
	return arrivals;
}

function phases(o) {
	const down = o.scenario === "down";
	const trip =
		o.mode === "window"
			? `more than ${PCT}% of the last ${WINDOW_SEC} s fail`
			: `${o.threshold} requests in a row fail`;
	return [
		{
			from: 0,
			to: BAD_FROM,
			tone: "good",
			label: "Healthy",
			caption:
				"Both clients send 10 requests per second, and every request is answered. On the right, the breaker is closed and counts failures. Before you press Play: when the host breaks at 6 s, how long will callers on each side wait?",
		},
		{
			from: BAD_FROM,
			to: BAD_TO,
			tone: "bad",
			label: down ? "Host down · every request times out" : "Host flaky · 40% of requests time out",
			caption: down
				? `The host just broke. On the left, every caller now waits the full 1 s timeout. On the right, the breaker opens once ${trip}. After that, callers get CircuitOpenError in about 0 ms. Watch the switch and the log.`
				: `40% of requests now time out, at random. The breaker opens only once ${trip}. Will that happen here? Watch the counter under the switch.`,
		},
		{
			from: BAD_TO,
			to: END,
			tone: "good",
			label: "Host fixed",
			caption: `The host works again. The left lane recovers at once. The right lane keeps rejecting requests until its next trial, up to ${o.resetSec} s later. That gap is the price of the breaker.`,
		},
	];
}

/** @returns {import("../engine/trace.js").DemoTrace} */
export function simulate(o) {
	const arrivals = arrivalsFor(o);
	const resultOf = (a) => ({
		request: a.request,
		t: a.end,
		ok: a.outcome === "ok",
		error: a.outcome === "timeout" ? "timeout" : a.outcome === "rejected" ? "circuit_open" : undefined,
	});

	// Lane without a breaker: every request reaches the host.
	const plain = arrivals.map((r) => ({
		request: r.id,
		n: 0,
		sent: r.t,
		start: r.t,
		end: r.t + r.lat,
		outcome: r.fails ? "timeout" : "ok",
	}));

	// Lane with a breaker.
	const br = { state: "closed", consec: 0, openedAt: 0, inflight: 0, gen: 0, win: [] };
	const states = [{ t: 0, state: "closed" }];
	const failures = [[0, 0]];
	const failRate = [[0, 0]];
	const attempts = [];
	const pending = [];
	const setState = (s, t, reason) => {
		br.state = s;
		states.push({ t, state: s, reason });
	};
	// Same shape as RollingWindow: 10 time buckets, and a bucket is dropped
	// whole once its start falls out of the window.
	const bucketMs = Math.floor((WINDOW_SEC * 1000) / 10);
	const bucketStart = (t) => Math.floor(toMs(t) / bucketMs) * bucketMs;
	const winStats = (t) => {
		const cutoff = toMs(t) - WINDOW_SEC * 1000;
		br.win = br.win.filter((w) => bucketStart(w.t) >= cutoff);
		const f = br.win.filter((w) => w.f).length;
		return { total: br.win.length, rate: br.win.length ? (f / br.win.length) * 100 : 0 };
	};
	const count = (t) => {
		failures.push([t, br.consec]);
		failRate.push([t, winStats(t).rate]);
	};
	const trips = (t) => {
		if (o.mode === "window") {
			const w = winStats(t);
			return w.total >= MIN_REQ && w.rate > PCT;
		}
		return br.consec >= o.threshold;
	};
	const complete = (p) => {
		const t = p.end;
		const isTrial = p.trialGen !== null && p.trialGen === br.gen;
		// A request admitted while closed must not decide a later half-open episode.
		if (br.state === "half-open" && !isTrial) return;
		if (!p.fails) {
			if (br.state === "half-open") {
				br.inflight = Math.max(0, br.inflight - 1);
				br.consec = 0;
				// Like resetCounters(), closing starts an empty window (#219).
				br.win = [];
				setState("closed", t, "trial request answered");
				count(t);
			} else if (br.state === "closed") {
				br.consec = 0;
				br.win.push({ t, f: false });
				count(t);
			}
		} else if (br.state === "half-open") {
			br.inflight = Math.max(0, br.inflight - 1);
			br.openedAt = t;
			setState("open", t, "trial request timed out");
		} else if (br.state === "closed") {
			br.consec++;
			br.win.push({ t, f: true });
			count(t);
			if (trips(t)) {
				br.openedAt = t;
				setState(
					"open",
					t,
					o.mode === "window"
						? `${Math.round(winStats(t).rate)}% of the last ${WINDOW_SEC} s failed`
						: `${br.consec} failures in a row`,
				);
			}
		}
	};
	const drain = (until) => {
		pending.sort((x, y) => x.end - y.end);
		while (pending.length && pending[0].end <= until) complete(pending.shift());
	};
	for (const r of arrivals) {
		drain(r.t);
		let admitted = true;
		let trialGen = null;
		if (br.state === "open") {
			if (r.t - br.openedAt >= o.resetSec) {
				br.inflight = 0;
				br.gen++;
				setState("half-open", r.t, `reset timeout (${o.resetSec} s) passed, sending one trial`);
			} else {
				admitted = false;
			}
		}
		if (admitted && br.state === "half-open") {
			if (br.inflight >= 1) admitted = false;
			else {
				br.inflight++;
				trialGen = br.gen;
			}
		}
		if (!admitted) {
			attempts.push({
				request: r.id,
				n: 0,
				sent: r.t,
				start: null,
				end: r.t + 0.002,
				outcome: "rejected",
				reason: "circuit_open",
			});
			continue;
		}
		const a = { request: r.id, n: 0, sent: r.t, start: r.t, end: r.t + r.lat, outcome: r.fails ? "timeout" : "ok" };
		if (trialGen !== null) a.trial = true;
		attempts.push(a);
		pending.push({ end: a.end, fails: r.fails, trialGen });
	}
	drain(Number.POSITIVE_INFINITY);

	const cfg =
		o.mode === "window"
			? `window: >${PCT}% of ${WINDOW_SEC} s, resetTimeout: ${o.resetSec} s`
			: `failureThreshold: ${o.threshold}, resetTimeout: ${o.resetSec} s`;
	return {
		version: 1,
		pattern: "circuit-breaker",
		duration: END,
		phases: phases(o),
		moments: states.slice(1).map((s, i) => ({
			t: s.t,
			label: `Breaker ${states[i].state} → ${s.state}: ${s.reason}`,
		})),
		lanes: {
			without: { config: "timeout: 1 s", attempts: plain, results: plain.map(resultOf) },
			with: { config: cfg, attempts, results: attempts.map(resultOf), states, series: { failures, failRate } },
		},
	};
}
