// Backoff + jitter demo model: every client's attempts, with the delay rule
// from src/core/backoff.ts. It runs in the page (for the sliders) and in
// test/demos/backoff-jitter.parity.test.ts, which checks it against the real
// HttpClient. No DOM access here.

import { timerDelay } from "../engine/time.js";

export const DOWN = 1.0;
export const START = 0.15;
export const STEP = 0.1;
const MAX_WAVE_MOMENTS = 4;

function rng(seed) {
	return () => {
		seed = (seed * 1664525 + 1013904223) >>> 0;
		return seed / 4294967296;
	};
}

/**
 * The clients' first-attempt times in whole ms, the same in both lanes and in
 * the parity test. Whole ms because that is what setTimeout runs on.
 */
export function firstAttempts(n) {
	const rand = rng(42);
	return Array.from({ length: n }, () => Math.trunc((START + rand() * 0.01) * 1000));
}

/** The random numbers the jitter lane draws, one per retry, in the order retries are scheduled. */
export const jitterSequence = () => rng(7);

/**
 * The host: down until DOWN, then it serves `capacity` requests per second,
 * counted in STEP-long buckets. Returns how many requests bucket b may serve.
 */
export const hostAllowance = (capacity) => {
	const cap = capacity * STEP;
	return (b) => Math.floor(cap * (b + 1) + 1e-9) - Math.floor(cap * b + 1e-9);
};

/** Stateful host: call with each attempt's time in whole ms, in time order. */
export function makeHost(capacity) {
	const allowed = hostAllowance(capacity);
	const counts = [];
	return (ms) => {
		const b = Math.floor(ms / (STEP * 1000));
		counts[b] = (counts[b] || 0) + 1;
		if (ms < DOWN * 1000) return "down";
		return counts[b] > allowed(b) ? "over" : "ok";
	};
}

/** One lane: every client's attempts, plus the load the host saw in each 100 ms step. */
function runLane(jitter, o) {
	const clients = [];
	const pending = [];
	firstAttempts(o.clients).forEach((t, i) => {
		// same first-attempt times in both lanes
		clients.push({ id: i, ok: false, done: null });
		pending.push({ c: i, k: 0, t });
	});
	const jr = jitterSequence();
	const attempts = [];
	const counts = [];
	const host = makeHost(o.capacity);
	while (pending.length) {
		let mi = 0;
		for (let i = 1; i < pending.length; i++) if (pending[i].t < pending[mi].t) mi = i;
		const p = pending.splice(mi, 1)[0];
		const b = Math.floor(p.t / (STEP * 1000));
		counts[b] = (counts[b] || 0) + 1;
		const result = host(p.t);
		attempts.push({ c: p.c, k: p.k, t: p.t / 1000, result });
		const cl = clients[p.c];
		if (result === "ok") {
			cl.ok = true;
			cl.done = p.t / 1000;
			continue;
		}
		if (p.k >= o.maxRetries) {
			cl.done = p.t / 1000;
			continue;
		}
		// backoff(attempt): base * 2^attempt, capped, then full jitter
		const capped = Math.min(o.base * 2 ** p.k, o.maxDelay * 1000);
		const delay = timerDelay(jitter ? jr() * capped : capped);
		pending.push({ c: p.c, k: p.k + 1, t: p.t + delay });
	}
	const nb = Math.ceil((attempts[attempts.length - 1].t + STEP) / STEP) + 1;
	const load = new Array(nb).fill(0).map((_, i) => (counts[i] || 0) / STEP);
	return { attempts, clients, load, doneAt: Math.max(...clients.map((c) => c.done)) };
}

/** Map a lane run onto the trace shape. */
function laneTrace(run, o, duration, config) {
	return {
		config,
		attempts: run.attempts.map((a) => ({
			request: a.c,
			n: a.k,
			sent: a.t,
			start: a.t,
			end: a.t,
			outcome: a.result === "ok" ? "ok" : "error",
			...(a.result === "ok" ? {} : { reason: a.result === "down" ? "host_down" : "over_capacity" }),
		})),
		results: run.clients.map((c) => ({
			request: c.id,
			t: c.done,
			ok: c.ok,
			...(c.ok ? {} : { error: "max_retries" }),
		})),
		series: {
			load: run.load.map((v, i) => [(i + 0.5) * STEP, v]),
			capacity: [
				[0, o.capacity],
				[duration, o.capacity],
			],
		},
	};
}

/** Key moments, all read off the two runs. */
function momentsOf(plain, jit, o, duration) {
	const moments = [];
	const waves = new Map();
	for (const a of plain.attempts) {
		if (a.k === 0) continue;
		if (!waves.has(a.k)) waves.set(a.k, []);
		waves.get(a.k).push(a);
	}
	const downWaves = [...waves].filter(([, w]) => w[0].t < DOWN);
	const upWaves = [...waves].filter(([, w]) => w[0].t >= DOWN);
	if (downWaves.length) {
		const first = downWaves[0][0];
		const last = downWaves[downWaves.length - 1][0];
		const n = downWaves.reduce((sum, [, w]) => sum + w.length, 0);
		moments.push({
			t: downWaves[0][1][0].t,
			label: `No jitter: ${first === last ? `retry ${first}` : `retries ${first} to ${last}`} arrive while the host is down, so all ${n} fail`,
		});
	}
	for (const [k, w] of upWaves.slice(0, MAX_WAVE_MOMENTS)) {
		const served = w.filter((a) => a.result === "ok").length;
		moments.push({
			t: w[0].t,
			label: `No jitter: retry wave ${k}, ${w.length} retries arrive together and the host serves ${served}`,
		});
	}
	// The jitter lane's load: when does it stay under capacity for good?
	let lastOver = -1;
	jit.load.forEach((v, i) => {
		if (i * STEP >= DOWN - 1e-9 && v > o.capacity) lastOver = i;
	});
	if (lastOver >= 0 && (lastOver + 1) * STEP < duration) {
		moments.push({ t: (lastOver + 1) * STEP, label: `Jitter: the load stays under ${o.capacity}/s from here` });
	}
	for (const [name, run] of [
		["No jitter", plain],
		["Jitter", jit],
	]) {
		const ok = run.clients.filter((c) => c.ok).length;
		moments.push({ t: run.doneAt, label: `${name}: all clients finished, ${ok} of ${o.clients} served` });
	}
	return moments.sort((x, y) => x.t - y.t);
}

/** @returns {import("../engine/trace.js").DemoTrace} */
export function simulate(o) {
	const plain = runLane(false, o);
	const jit = runLane(true, o);
	const duration = Math.max(4, Math.ceil(Math.max(plain.doneAt, jit.doneAt) + 0.6));
	const cfg = (j) => `backoff: { baseDelayMs: ${o.base}, jitter: ${j} }`;
	return {
		version: 1,
		pattern: "backoff-jitter",
		duration,
		phases: [
			{
				from: 0,
				to: DOWN,
				tone: "bad",
				label: "Host down",
				caption: `All ${o.clients} clients failed at the same moment. When will their retries arrive? On the left, every client waits the same time. On the right, each client picks its own delay.`,
			},
			{
				from: DOWN,
				to: duration,
				tone: "good",
				label: `Host up · serves ${o.capacity}/s`,
				caption: `The host works again, but it can serve only ${o.capacity} requests per second. On the left, the clients come back in waves, and each wave is too big. On the right, the retries are spread out in time.`,
			},
		],
		moments: momentsOf(plain, jit, o, duration),
		lanes: {
			without: laneTrace(plain, o, duration, cfg(false)),
			with: laneTrace(jit, o, duration, cfg(true)),
		},
	};
}
