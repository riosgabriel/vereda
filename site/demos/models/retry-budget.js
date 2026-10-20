// Retry budget demo model: an aggregate (fluid) model. Each 0.1 s tick it moves
// fractional amounts of traffic through an invented host (capacity, overload
// collapse, 5% random failures, 0.3 s retry delay). Only `admit` is Vereda's
// rule (src/queue/retry-budget.ts, tryWithdraw); test/demos/retry-budget.parity.test.ts
// checks it against the real RetryBudget. The host physics are not verified.
// No DOM access here.

// ---- Simulation: fluid model, deterministic -------------------------------
export const DT = 0.1;
export const RATE = 80;
const DELAY = 3;
const P0 = 0.05;
export const END = 40;
export const FLOOR = 1;
export const BAD_FROM = 8;
export const BAD_TO = 24;
/** The budget window is 1 s of 0.1 s buckets, like BUCKET_COUNT in retry-budget.ts. */
export const WINDOW_TICKS = 10;
const capacityAt = (t) => (t < BAD_FROM ? 120 : t < BAD_TO ? 60 : 120);
const collapse = (x) => (x <= 1 ? 1 : Math.max(0.3, 1 - 0.6 * (x - 1)));

/**
 * The budget rule from RetryBudget.tryWithdraw, for traffic that moves in
 * fractions. `requests` and `retries` are what the window holds (this tick's
 * first attempts already counted), `floor` is minRetriesPerSec x window
 * seconds, `want` the retries asking to go. A retry is admitted while
 * retries < max(floor, ratio x requests), so the room is that limit minus the
 * retries already spent, never below 0. Returns how many of `want` get through.
 * The page uses fractions. With `whole` (the parity test, whole requests) the
 * room rounds up, because the real budget admits a retry whenever retries is
 * still below the limit.
 */
export function admit({ requests, retries, ratio, floor, want, whole = false }) {
	const room = Math.max(0, Math.max(floor, ratio * requests) - retries);
	return Math.min(want, whole ? Math.ceil(room - 1e-9) || 0 : room);
}

/**
 * One tick of the budget lane's window: counts this tick's first attempts,
 * asks `admit` about the retries wanting to go and records only the admitted
 * ones. `win` holds the last `windowTicks` ticks (oldest first) and is changed
 * in place. Returns the admitted retries.
 */
export function budgetStep(win, { first, want, ratio, floor }, whole = false, windowTicks = WINDOW_TICKS) {
	win.push({ req: first, ret: 0 });
	if (win.length > windowTicks) win.shift();
	const requests = win.reduce((s, b) => s + b.req, 0);
	const retries = win.reduce((s, b) => s + b.ret, 0);
	const admitted = admit({ requests, retries, ratio, floor, want, whole });
	win[win.length - 1].ret = admitted;
	return admitted;
}

function run(budget, o) {
	const pending = [];
	const win = [];
	const out = [];
	for (let i = 0; i <= END / DT; i++) {
		const t = i * DT;
		const C = capacityAt(t);
		const due = [];
		for (let j = pending.length - 1; j >= 0; j--) if (pending[j].at <= i) due.push(pending.splice(j, 1)[0]);
		const first = RATE * DT;
		const want = due.reduce((s, r) => s + r.n, 0);
		let f = 1;
		if (budget) {
			const admitted = budgetStep(win, { first, want, ratio: o.ratio, floor: FLOOR });
			f = want > 0 ? admitted / want : 1;
		}
		const refused = want * (1 - f);
		const levels = [{ k: 0, n: first }, ...due.map((r) => ({ k: r.k, n: r.n * f }))];
		const L = levels.reduce((s, a) => s + a.n, 0);
		const ok = Math.min(L, C * collapse(L / DT / C) * DT) * (1 - P0);
		const p = L > 0 ? 1 - ok / L : 0;
		for (const a of levels)
			if (a.k < o.maxRetries && a.n * p > 1e-6) pending.push({ k: a.k + 1, n: a.n * p, at: i + DELAY });
		out.push({ t, first, want, C, load: L / DT, retries: (L - first) / DT, ok: ok / DT, refused: refused / DT, p });
	}
	return out;
}

export const toLane = (ticks, config) => ({
	config,
	attempts: [],
	results: [],
	series: {
		load: ticks.map((s) => [s.t, s.load]),
		retries: ticks.map((s) => [s.t, s.retries]),
		ok: ticks.map((s) => [s.t, s.ok]),
		refused: ticks.map((s) => [s.t, s.refused]),
		capacity: ticks.map((s) => [s.t, s.C]),
		failP: ticks.map((s) => [s.t, s.p]),
	},
});

export function phases(metastable, o) {
	return [
		{
			from: 0,
			to: BAD_FROM,
			tone: "good",
			label: "Healthy · 120/s",
			caption:
				"Both clients send 80 requests per second. The host can serve 120, so every request is answered. Before you press Play: when the host slows down at 8 s, what will each client's load do?",
		},
		{
			from: BAD_FROM,
			to: BAD_TO,
			tone: "bad",
			label: "Host slow · serves 60/s",
			caption: `The host now serves only 60 per second, so requests time out. Both clients retry them, up to ${o.maxRetries} times. On the left, every failure comes back as a retry, so the load climbs far above 80. On the right, the budget refuses most retries, so the load stays close to normal. Watch the host's gauge and the load chart.`,
		},
		{
			from: BAD_TO,
			to: END,
			tone: "good",
			label: "Host fixed · 120/s again",
			caption: metastable
				? "The host works again and can serve 120 per second. Watch the left lane. Its retries still send more than 120, so it stays down. The right lane is already healthy."
				: "The host works again and can serve 120 per second. Both lanes carry less than 120, so both recover.",
		},
	];
}

/** Key moments, read off the simulated series (never hand-written times). */
export function momentsOf(a, b) {
	const n = (v) => Math.round(v);
	const moments = [];
	const over = a.find((s) => s.load > s.C);
	if (over) moments.push({ t: over.t, label: `No budget: load passes capacity (${n(over.load)}/s vs ${over.C}/s)` });
	const refusing = b.find((s) => s.refused > 0.5);
	if (refusing)
		moments.push({ t: refusing.t, label: `Budget: the first retries are refused (${n(refusing.refused)}/s)` });
	const fixA = a.find((s) => s.t >= BAD_TO);
	if (fixA) {
		const back = a.find((s) => s.t >= BAD_TO && s.load <= s.C);
		moments.push(
			back
				? { t: back.t, label: `No budget: load falls under capacity (${n(back.load)}/s vs ${back.C}/s)` }
				: {
						t: fixA.t,
						label: `No budget: the host is fixed, but load stays at ${n(fixA.load)}/s vs ${fixA.C}/s capacity`,
					},
		);
	}
	const lastRefused = b.findLastIndex((s) => s.refused > 0.5);
	const after = lastRefused >= 0 ? b[lastRefused + 1] : null;
	if (after && refusing && after.t > refusing.t) {
		moments.push({ t: after.t, label: `Budget: refusals stop, load is ${n(after.load)}/s vs ${after.C}/s capacity` });
	}
	return moments.sort((x, y) => x.t - y.t);
}

/** @returns {import("../engine/trace.js").DemoTrace} */
export function simulate(o) {
	const a = run(false, o);
	const b = run(true, o);
	const metastable = a.every((s) => s.t < BAD_TO || s.load > s.C);
	const ratio = o.ratio.toFixed(2).replace(/0$/, "");
	return {
		version: 1,
		pattern: "retry-budget",
		duration: END,
		phases: phases(metastable, o),
		moments: momentsOf(a, b),
		lanes: {
			without: toLane(a, `retry: { maxRetries: ${o.maxRetries} }`),
			with: toLane(b, `retryBudget: { ratio: ${ratio}, windowMs: 1000 }`),
		},
	};
}
