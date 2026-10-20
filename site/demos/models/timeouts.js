// Timeouts demo model: one request to a host that never answers, following
// queue/retry.ts and queue/executor.ts. It runs in the page (for the sliders)
// and in test/demos/timeouts.parity.test.ts, which checks its attempts and
// results against the real HttpClient. No DOM access here.
//
// Not checked by the test: `hostEnd` (the host keeps working HOST_TAIL s after
// an abort) is invented physics. The real client cannot observe the host.

// Same rules as queue/retry.ts and queue/executor.ts.
export const BASE_MS = 200;
export const MAX_DELAY = 30;
export const HOST_TAIL = 6;
export const SWEEP_MAX = 13;
export const INF = Number.POSITIVE_INFINITY;

export function runModel(o, total) {
	const deadline = total;
	const attempts = [];
	let t = 0;
	let answerAt = INF;
	let error = "never";
	let skipped = false;
	// The kind of the error's `cause`: only the skipped-retry path wraps the last TimeoutError.
	let cause;
	for (let k = 0; k <= o.maxRetries; k++) {
		const start = t;
		const attemptEnd = o.attemptSec === INF ? INF : start + o.attemptSec;
		if (deadline <= attemptEnd && deadline !== INF) {
			// Deadline timer fires first: ticket signal aborts the attempt in flight.
			attempts.push({ k, start, end: deadline, outcome: "aborted", hostEnd: deadline + HOST_TAIL });
			answerAt = deadline;
			error = "deadline";
			break;
		}
		if (attemptEnd === INF) {
			attempts.push({ k, start, end: INF, outcome: "hang", hostEnd: INF });
			break;
		}
		attempts.push({ k, start, end: attemptEnd, outcome: "timeout", hostEnd: attemptEnd + HOST_TAIL });
		t = attemptEnd;
		if (k === o.maxRetries) {
			answerAt = t;
			error = o.maxRetries === 0 ? "timeout" : "max_retries";
			break;
		}
		const delay = Math.min(BASE_MS * 2 ** k, MAX_DELAY * 1000) / 1000;
		if (deadline !== INF && t + delay >= deadline) {
			// A delay that runs to or past the deadline fails now (retry.ts:184).
			answerAt = t;
			error = "deadline";
			skipped = true;
			cause = "timeout";
			break;
		}
		t += delay;
	}
	return { attempts, answerAt, error, cause, skipped, total };
}

// ---- Trace ----------------------------------------------------------------
function phases(o, duration, leftDoneAt, rightDoneAt) {
	const retries = o.maxRetries === 0 ? "no retries" : o.maxRetries === 1 ? "1 retry" : `${o.maxRetries} retries`;
	// The host hangs for the whole run. When the deadline ends the right lane before the left one,
	// a second phase marks it; both are the same "bad" tone, because the host never recovers.
	const split = o.totalSec !== INF && rightDoneAt < Math.min(leftDoneAt, duration);
	const first = {
		from: 0,
		to: split ? rightDoneAt : duration,
		tone: "bad",
		label: "Host hangs",
		caption:
			o.attemptSec === INF
				? "The host never answers, and there is no limit on one attempt. Will either caller ever hear back?"
				: `The host never answers. Each attempt waits ${o.attemptSec} s and there ${o.maxRetries === 1 ? "is" : "are"} ${retries}${o.totalSec === INF ? "" : `. The right lane also has a ${o.totalSec} s deadline`}. When will each caller hear back?`,
	};
	if (!split) return [first];
	return [
		first,
		{
			from: rightDoneAt,
			to: duration,
			tone: "bad",
			label: "Host hangs · right lane done",
			caption: "The right lane is finished. The host still hangs, so only the left lane can still be waiting.",
		},
	];
}

function laneTrace(run, duration, config) {
	const attempts = run.attempts.map((a) => {
		const hangs = a.end === INF;
		const out = {
			request: 0,
			n: a.k,
			sent: a.start,
			start: a.start,
			end: hangs ? duration : a.end,
			outcome: hangs ? "hang" : a.outcome,
			hostEnd: hangs ? duration : a.hostEnd,
		};
		if (a.outcome === "aborted") out.reason = "deadline";
		return out;
	});
	const results = Number.isFinite(run.answerAt) ? [{ request: 0, t: run.answerAt, ok: false, error: run.error }] : [];
	return { config, attempts, results };
}

/** Key moments, read from the finished lanes. At most 8, and the ones where a caller hears back come first. */
function momentsOf(lanes) {
	const found = [];
	for (const [name, lane] of [
		["Timeout only", lanes.without],
		["With deadline", lanes.with],
	]) {
		const res = lane.results[0];
		lane.attempts.forEach((a, i) => {
			const n = a.n + 1;
			const last = i === lane.attempts.length - 1;
			if (a.outcome === "aborted") {
				found.push({
					t: a.end,
					name,
					final: true,
					text: `the deadline aborts attempt #${n}. The caller hears ${res.error}.`,
				});
			} else if (a.outcome === "timeout" && last && res && res.t === a.end) {
				const tail =
					res.error === "deadline"
						? "The next backoff would pass the deadline, so the retry is skipped. The caller hears deadline."
						: res.error === "max_retries"
							? "There are no retries left. The caller hears max_retries."
							: "The caller hears timeout.";
				found.push({ t: a.end, name, final: true, text: `attempt #${n} times out. ${tail}` });
			} else if (a.outcome === "timeout") {
				found.push({ t: a.end, name, final: false, text: `attempt #${n} times out.` });
			}
		});
	}
	// Both lanes often time out the same attempt at the same moment: say it once.
	const merged = [];
	for (const m of found) {
		const twin = merged.find((x) => x.t === m.t && x.text === m.text);
		if (twin) twin.name = "Both lanes";
		else merged.push({ ...m });
	}
	while (merged.length > 8) {
		let drop = -1;
		merged.forEach((m, i) => {
			if (!m.final) drop = i;
		});
		if (drop < 0) break;
		merged.splice(drop, 1);
	}
	return merged.sort((a, b) => a.t - b.t).map((m) => ({ t: m.t, label: `${m.name}: ${m.text}` }));
}

/** @returns {import("../engine/trace.js").DemoTrace} */
export function simulate(o) {
	const base = { attemptSec: o.attemptSec, maxRetries: o.maxRetries };
	const a = runModel(base, INF);
	const b = runModel(base, o.totalSec);
	const finite = [a.answerAt, b.answerAt].filter(Number.isFinite);
	let duration = Math.min(30, Math.max(6, Math.ceil(Math.max(0, ...finite) + 1.5)));
	if (finite.length < 2) duration = Math.max(duration, 10);
	const att = o.attemptSec === INF ? "Infinity" : String(o.attemptSec * 1000);
	const lanes = {
		without: laneTrace(a, duration, `timeout: { attemptMs: ${att} }`),
		with: laneTrace(
			b,
			duration,
			o.totalSec === INF
				? `timeout: { attemptMs: ${att} }`
				: `timeout: { attemptMs: ${att}, totalMs: ${o.totalSec * 1000} }`,
		),
	};
	return {
		version: 1,
		pattern: "timeouts",
		duration,
		phases: phases(o, duration, a.answerAt, b.answerAt),
		moments: momentsOf(lanes),
		lanes,
	};
}
