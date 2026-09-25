import type { BenchmarkResult } from "./utils.ts";

export interface Thresholds {
	maxAvgLatencyMs?: number;
	maxP95LatencyMs?: number;
	maxP99LatencyMs?: number;
	minSuccessRate?: number; // 0-1
	minRequestsPerSecond?: number;
}

export interface ThresholdViolation {
	metric: string;
	limit: number;
	actual: number;
}

/**
 * Compares a benchmark result against its configured pass/fail thresholds.
 * Only thresholds that are set are checked. Returns one violation per
 * breached metric, or an empty array if the result is within all limits.
 */
export function checkThresholds(result: BenchmarkResult, thresholds: Thresholds): ThresholdViolation[] {
	const violations: ThresholdViolation[] = [];

	if (thresholds.maxAvgLatencyMs !== undefined && result.avgLatencyMs > thresholds.maxAvgLatencyMs) {
		violations.push({ metric: "avgLatencyMs", limit: thresholds.maxAvgLatencyMs, actual: result.avgLatencyMs });
	}

	if (thresholds.maxP95LatencyMs !== undefined && result.p95LatencyMs > thresholds.maxP95LatencyMs) {
		violations.push({ metric: "p95LatencyMs", limit: thresholds.maxP95LatencyMs, actual: result.p95LatencyMs });
	}

	if (thresholds.maxP99LatencyMs !== undefined && result.p99LatencyMs > thresholds.maxP99LatencyMs) {
		violations.push({ metric: "p99LatencyMs", limit: thresholds.maxP99LatencyMs, actual: result.p99LatencyMs });
	}

	if (thresholds.minRequestsPerSecond !== undefined && result.requestsPerSecond < thresholds.minRequestsPerSecond) {
		violations.push({
			metric: "requestsPerSecond",
			limit: thresholds.minRequestsPerSecond,
			actual: result.requestsPerSecond,
		});
	}

	if (thresholds.minSuccessRate !== undefined) {
		const successRate = result.totalRequests > 0 ? result.successfulRequests / result.totalRequests : 0;
		if (successRate < thresholds.minSuccessRate) {
			violations.push({ metric: "successRate", limit: thresholds.minSuccessRate, actual: successRate });
		}
	}

	return violations;
}
