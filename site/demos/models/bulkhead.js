// Bulkhead demo model: one record per request, following src/queue/bulkhead.ts
// and src/queue/semaphore.ts. It runs in the page (for the sliders) and in
// test/demos/bulkhead.parity.test.ts, which checks it against the real
// HttpClient. No DOM access here.

import { onMsGrid } from "../engine/time.js";

// ---- Simulation: one record per request, same rules as bulkhead.ts + semaphore.ts ----
export const END = 32;
export const BAD_FROM = 6;
export const BAD_TO = 20;
export const PAY_RATE = 6;
export const SRCH_RATE = 4;
export const TIMEOUT = 6;
export const GQ = 20; // global queue size
export const PQ = 10; // search partition queue size
export const STEP = 0.25; // sampling step of the permitsHeld series

function rng(seed) {
	return () => {
		seed = (seed * 1664525 + 1013904223) >>> 0;
		return seed / 4294967296;
	};
}
export const isBad = (t) => t >= BAD_FROM && t < BAD_TO;

/**
 * The traffic, shared by the model and the parity test so both see exactly the
 * same requests. Every request has an arrival time `t` and a random draw `u`
 * that `hostAnswer` turns into the host's latency.
 */
export function arrivalsFor(_o) {
	const rand = rng(7);
	const list = [];
	for (let i = 0; i < END * PAY_RATE; i++)
		list.push({ part: "pay", t: onMsGrid(i / PAY_RATE + 0.02 + rand() * 0.06), u: rand() });
	for (let i = 0; i < END * SRCH_RATE; i++)
		list.push({ part: "srch", t: onMsGrid(i / SRCH_RATE + 0.07 + rand() * 0.1), u: rand() });
	list.sort((x, y) => x.t - y.t);
	return list.map((r, id) => ({ id, ...r }));
}

/**
 * The host's behaviour for a request that reaches it at time `t`: how long it
 * takes to answer, and whether the answer is cut by the attempt timeout.
 */
export function hostAnswer(o, r, t) {
	if (r.part === "pay") return { dur: onMsGrid(0.1 + r.u * 0.1), kind: "ok" };
	if (!isBad(t)) return { dur: onMsGrid(0.15 + r.u * 0.15), kind: "ok" };
	const lat = o.slow * (0.85 + 0.3 * r.u);
	return lat >= TIMEOUT ? { dur: TIMEOUT, kind: "timeout" } : { dur: onMsGrid(lat), kind: "ok" };
}

// bulk = true: search first goes through its own partition slots (limitFirstAttempts), then the global semaphore.
export function lane(arrivals, o, bulk) {
	const recs = arrivals.map((a) => ({
		...a,
		slot: false,
		pStart: null,
		start: null,
		end: null,
		kind: null,
		scope: null,
	}));
	let gAvail = o.G;
	let pRun = 0;
	const gQ = [];
	const pQ = [];
	const pend = [];
	const reject = (r, t, scope) => {
		r.kind = "rejected";
		r.scope = scope;
		r.end = t;
	};
	const grant = (r, t) => {
		gAvail--;
		r.start = t;
		const d = hostAnswer(o, r, t);
		r.end = t + d.dur;
		r.kind = d.kind;
		pend.push(r);
	};
	const freeSlot = (t) => {
		pRun--;
		while (pRun < o.C && pQ.length) {
			const n = pQ.shift();
			pRun++;
			n.slot = true;
			n.pStart = t;
			acquire(n, t);
		}
	};
	// semaphore.acquire: a free permit, else the global queue, else QueueFullError("global")
	const acquire = (r, t) => {
		if (gAvail > 0) grant(r, t);
		else if (gQ.length >= GQ) {
			reject(r, t, "global");
			if (r.slot) freeSlot(t);
		} else gQ.push(r);
	};
	// bulkhead.run: a free slot, else the partition queue, else QueueFullError("partition")
	const arrive = (r, t) => {
		if (bulk && r.part === "srch") {
			if (pRun < o.C) {
				pRun++;
				r.slot = true;
				r.pStart = t;
				acquire(r, t);
			} else if (pQ.length < PQ) pQ.push(r);
			else reject(r, t, "partition");
		} else {
			r.pStart = t;
			acquire(r, t);
		}
	};
	// release order as in bulkhead.ts: permit first, then the slot
	const done = (r) => {
		gAvail++;
		while (gAvail > 0 && gQ.length) grant(gQ.shift(), r.end);
		if (r.slot) freeSlot(r.end);
	};
	const drain = (until) => {
		for (;;) {
			pend.sort((x, y) => x.end - y.end);
			if (!pend.length || pend[0].end > until) break;
			done(pend.shift());
		}
	};
	for (const r of recs) {
		drain(r.t);
		arrive(r, r.t);
	}
	drain(Number.POSITIVE_INFINITY);
	return recs;
}

/** Turn the model's request records into trace attempts and results. */
export function toLane(recs, o, config) {
	const attempts = recs.map((r) => {
		const a = {
			request: r.id,
			n: 0,
			sent: r.t,
			start: r.start,
			end: r.end,
			outcome: r.kind,
			partition: r.part === "pay" ? "payments" : "search",
		};
		if (r.kind === "rejected") a.reason = `queue_full:${r.scope}`;
		if (r.slot) a.slot = r.pStart;
		return a;
	});
	const results = attempts.map((a) => ({
		request: a.request,
		t: a.end,
		ok: a.outcome === "ok",
		error: a.outcome === "timeout" ? "timeout" : a.outcome === "rejected" ? "queue_full" : undefined,
	}));
	// Global permits held by search, sampled every STEP seconds.
	const n = new Array(Math.round(END / STEP) + 1).fill(0);
	for (const a of attempts) {
		if (a.partition !== "search" || a.start === null) continue;
		for (let i = Math.ceil(a.start / STEP); i < n.length && i * STEP < a.end; i++) n[i]++;
	}
	const series = {
		permitsHeld: n.map((v, i) => [i * STEP, v]),
		permitCap: [[0, o.G]],
		slotCap: [[0, o.C]],
	};
	return { config, attempts, results, series };
}

const searchHolds = (attempts, s) =>
	attempts.filter((a) => a.partition === "search" && a.start !== null && a.start <= s && s < a.end).length;
const slotsHeld = (attempts, s) =>
	attempts.filter((a) => a.slot !== undefined && a.outcome !== "rejected" && a.slot <= s && s < a.end).length;
const firstWhere = (times, pred) => [...times].sort((x, y) => x - y).find(pred);

function momentsOf(without, withB, o) {
	const out = [];
	const add = (t, label) => {
		if (t !== undefined) out.push({ t, label });
	};
	const a = without.attempts;
	const b = withB.attempts;
	add(
		firstWhere(
			a.filter((x) => x.start !== null).map((x) => x.start),
			(s) => searchHolds(a, s) >= o.G,
		),
		`Global only: search holds all ${o.G} global permits`,
	);
	add(
		a.find((x) => x.partition === "payments" && x.outcome === "rejected")?.end,
		"Global only: the global queue is full, so the first payments request is rejected",
	);
	add(
		firstWhere(
			b.filter((x) => x.slot !== undefined).map((x) => x.slot),
			(s) => slotsHeld(b, s) >= o.C,
		),
		`With search limit: search fills its ${o.C} slots`,
	);
	add(
		b.find((x) => x.reason === "queue_full:partition")?.end,
		"With search limit: the search queue is full, so the first search request is rejected",
	);
	add(
		b.find((x) => x.partition === "search" && x.outcome === "ok" && x.start >= BAD_TO)?.end,
		"With search limit: search is back to normal",
	);
	return out.sort((x, y) => x.t - y.t);
}

function phasesOf(o) {
	const down = o.slow >= TIMEOUT;
	return [
		{
			from: 0,
			to: BAD_FROM,
			tone: "good",
			label: "Both healthy",
			caption:
				"Both clients send the same traffic: 6 payments requests and 4 search requests per second. Every request is fast. Before you press Play: when search gets slow, what happens to payments on each side?",
		},
		{
			from: BAD_FROM,
			to: BAD_TO,
			tone: "bad",
			label: down ? "Search is down · every request times out" : `Search is slow · answers in about ${o.slow} s`,
			caption: down
				? `Search just went down, and every search request waits ${TIMEOUT} s before it times out. On the left, search can take every global permit. Payments then waits in the same queue. On the right, search can use only ${o.C} permits.`
				: `Search just got slow. On the left, search can take every global permit. Payments then waits in the same queue. On the right, search can use only ${o.C} permits, and the rest of its requests wait in the search queue.`,
		},
		{
			from: BAD_TO,
			to: END,
			tone: "good",
			label: "Search fixed",
			caption:
				"Search answers fast again. Requests that already wait in a queue still have to run, so the queues need a few seconds to empty.",
		},
	];
}

/** @returns {import("../engine/trace.js").DemoTrace} */
export function simulate(o) {
	const arr = arrivalsFor(o);
	const without = toLane(lane(arr, o, false), o, `concurrency: ${o.G}, maxQueueSize: ${GQ}, maxRetries: 0`);
	const withB = toLane(lane(arr, o, true), o, `search: concurrency ${o.C}, limitFirstAttempts; maxRetries: 0`);
	return {
		version: 1,
		pattern: "bulkhead",
		duration: END,
		phases: phasesOf(o),
		moments: momentsOf(without, withB, o),
		lanes: { without, with: withB },
	};
}
