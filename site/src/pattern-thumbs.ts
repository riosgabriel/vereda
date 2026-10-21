import type { DemoTrace, LaneTrace } from "../demos/engine/trace.js";
import { simulate as simulateBackoffJitter } from "../demos/models/backoff-jitter.js";
import { simulate as simulateBulkhead } from "../demos/models/bulkhead.js";
import { simulate as simulateCircuitBreaker } from "../demos/models/circuit-breaker.js";
import { simulate as simulateRateLimiter } from "../demos/models/rate-limiter.js";
import { simulate as simulateRetryBudget } from "../demos/models/retry-budget.js";
import { simulate as simulateTimeouts } from "../demos/models/timeouts.js";
import type { PATTERNS } from "./patterns.ts";

export type PatternSlug = (typeof PATTERNS)[number]["slug"];

export type Point = readonly [number, number];

export interface PatternThumb {
	readonly duration: number;
	readonly yMax: number;
	readonly badPhases: ReadonlyArray<{ readonly from: number; readonly to: number }>;
	readonly without: readonly Point[];
	readonly with: readonly Point[];
}

interface Series {
	readonly without: readonly Point[];
	readonly with: readonly Point[];
	readonly yMax?: number;
}

const BACKOFF_STEP = 0.1;
const TIMEOUTS_STEP = 0.1;

function perSecond(
	attempts: LaneTrace["attempts"],
	duration: number,
	secondOf: (a: LaneTrace["attempts"][number]) => number | null,
): Point[] {
	const counts = new Array<number>(Math.ceil(duration)).fill(0);
	for (const a of attempts) {
		const s = secondOf(a);
		if (s !== null) counts[Math.min(counts.length - 1, Math.floor(s))]++;
	}
	return counts.map((v, i): Point => [i + 0.5, v]);
}

function servedCumulative(lane: LaneTrace, duration: number): Point[] {
	const served = lane.results
		.filter((r) => r.ok)
		.map((r) => r.t)
		.sort((x, y) => x - y);
	const out: Point[] = [];
	let k = 0;
	for (let i = 0; i * BACKOFF_STEP <= duration; i++) {
		const t = i * BACKOFF_STEP;
		while (k < served.length && (served[k] ?? Number.POSITIVE_INFINITY) <= t) k++;
		out.push([t, k]);
	}
	return out;
}

function hostBusySeries(lane: LaneTrace, duration: number): Point[] {
	const out: Point[] = [];
	for (let i = 0; i * TIMEOUTS_STEP <= duration + 1e-9; i++) {
		const t = i * TIMEOUTS_STEP;
		let busy = 0;
		for (const a of lane.attempts) {
			if (a.start === null) continue;
			busy += Math.max(0, Math.min(t, a.hostEnd ?? a.end) - a.start);
		}
		out.push([t, busy]);
	}
	return out;
}

function seriesOf(lane: LaneTrace, key: string): Point[] {
	return lane.series?.[key] ?? [];
}

function keySeries(slug: PatternSlug): { trace: DemoTrace; series: Series } {
	switch (slug) {
		case "retry-budget": {
			const trace = simulateRetryBudget({ maxRetries: 3, ratio: 0.1 });
			return {
				trace,
				series: { without: seriesOf(trace.lanes.without, "load"), with: seriesOf(trace.lanes.with, "load") },
			};
		}
		case "bulkhead": {
			const trace = simulateBulkhead({ slow: 4, G: 8, C: 3 });
			const cap = trace.lanes.with.series?.permitCap?.[0]?.[1];
			return {
				trace,
				series: {
					without: seriesOf(trace.lanes.without, "permitsHeld"),
					with: seriesOf(trace.lanes.with, "permitsHeld"),
					yMax: cap,
				},
			};
		}
		case "backoff-jitter": {
			const trace = simulateBackoffJitter({ clients: 100, base: 200, maxRetries: 5, maxDelay: 30, capacity: 40 });
			return {
				trace,
				series: {
					without: servedCumulative(trace.lanes.without, trace.duration),
					with: servedCumulative(trace.lanes.with, trace.duration),
					yMax: 100,
				},
			};
		}
		case "circuit-breaker": {
			const trace = simulateCircuitBreaker({ scenario: "down", mode: "consec", threshold: 5, resetSec: 4 });
			const reached = (a: LaneTrace["attempts"][number]) => (a.start === null ? null : a.sent);
			return {
				trace,
				series: {
					without: perSecond(trace.lanes.without.attempts, trace.duration, reached),
					with: perSecond(trace.lanes.with.attempts, trace.duration, reached),
					yMax: 12,
				},
			};
		}
		case "rate-limiter": {
			const trace = simulateRateLimiter({ tokensPerSec: 15, burst: 5, maxWaitMs: 5000, retries: true });
			const reached = (a: LaneTrace["attempts"][number]) => a.start;
			return {
				trace,
				series: {
					without: perSecond(trace.lanes.without.attempts, trace.duration, reached),
					with: perSecond(trace.lanes.with.attempts, trace.duration, reached),
				},
			};
		}
		case "timeouts": {
			const trace = simulateTimeouts({ attemptSec: 2, totalSec: 4, maxRetries: 3 });
			return {
				trace,
				series: {
					without: hostBusySeries(trace.lanes.without, trace.duration),
					with: hostBusySeries(trace.lanes.with, trace.duration),
				},
			};
		}
	}
}

export function patternThumb(slug: PatternSlug): PatternThumb {
	const { trace, series } = keySeries(slug);
	const peak = Math.max(0, ...series.without.map((p) => p[1]), ...series.with.map((p) => p[1]));
	const yMax = series.yMax !== undefined && series.yMax > 0 ? Math.max(series.yMax, peak) : peak || 1;
	return {
		duration: trace.duration,
		yMax,
		badPhases: trace.phases.filter((p) => p.tone === "bad").map((p) => ({ from: p.from, to: p.to })),
		without: series.without,
		with: series.with,
	};
}
