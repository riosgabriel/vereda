import { HttpClient } from "@vereda/http";
import { checkThresholds, type Thresholds } from "./thresholds.ts";
import {
	type BenchmarkResult,
	calculatePercentile,
	printResults,
	runBenchmark,
	saveResults,
	TestServer,
} from "./utils.ts";

/**
 * Comprehensive benchmark runner
 * Executes all benchmarks and generates a summary report
 */
type BenchmarkFn = () => Promise<BenchmarkResult>;

const benchmarks: Record<string, BenchmarkFn> = {
	// Load Tests
	"Basic Load Test": async () => {
		const server = new TestServer({ baseLatencyMs: 10, jitterMs: 5 });
		await server.start();
		try {
			const client = HttpClient.create({
				baseUrl: server.baseUrl,
				retry: { maxRetries: 3 },
				timeout: { attemptMs: 5000 },
			});
			return await runBenchmark(client, {
				name: "Basic Load Test",
				totalRequests: 500,
				concurrency: 20,
				warmupRequests: 50,
			});
		} finally {
			await server.stop();
		}
	},

	"Stress Test (Low Concurrency)": async () => {
		const server = new TestServer({ baseLatencyMs: 20, jitterMs: 10 });
		await server.start();
		try {
			const client = HttpClient.create({
				baseUrl: server.baseUrl,
				retry: { maxRetries: 2 },
				timeout: { attemptMs: 3000 },
			});
			return await runBenchmark(client, {
				name: "Stress Test (Low Concurrency)",
				totalRequests: 500,
				concurrency: 50,
				warmupRequests: 20,
			});
		} finally {
			await server.stop();
		}
	},

	"Stress Test (High Concurrency)": async () => {
		const server = new TestServer({ baseLatencyMs: 20, jitterMs: 10 });
		await server.start();
		try {
			const client = HttpClient.create({
				baseUrl: server.baseUrl,
				retry: { maxRetries: 2 },
				timeout: { attemptMs: 3000 },
				concurrency: 200,
			});
			return await runBenchmark(client, {
				name: "Stress Test (High Concurrency)",
				totalRequests: 1000,
				concurrency: 200,
				warmupRequests: 20,
			});
		} finally {
			await server.stop();
		}
	},

	// Chaos Tests
	"Network Chaos (30% failures)": async () => {
		const server = new TestServer({
			baseLatencyMs: 10,
			jitterMs: 5,
			failRate: 0.3,
			statusCodes: [500, 502, 503, 504],
		});
		await server.start();
		try {
			const client = HttpClient.create({
				baseUrl: server.baseUrl,
				retry: { maxRetries: 3, backoff: { baseDelayMs: 100, maxDelayMs: 5000, jitter: true } },
				timeout: { attemptMs: 3000 },
			});
			return await runBenchmark(client, {
				name: "Network Chaos (30% failures)",
				totalRequests: 200,
				concurrency: 20,
			});
		} finally {
			await server.stop();
		}
	},

	// Scenarios
	"Bulkhead Isolation": async () => {
		const fastServer = new TestServer({ baseLatencyMs: 5, jitterMs: 2 });
		const slowServer = new TestServer({ baseLatencyMs: 100, jitterMs: 50, failRate: 0.5, statusCodes: [500, 503] });
		await Promise.all([fastServer.start(), slowServer.start()]);
		try {
			const client = HttpClient.create({
				concurrency: 10,
				partitions: {
					[fastServer.baseUrl.replace("http://", "")]: { concurrency: 5, maxQueueSize: 20 },
					[slowServer.baseUrl.replace("http://", "")]: { concurrency: 2, maxQueueSize: 10 },
				},
				retry: { maxRetries: 2 },
				timeout: { attemptMs: 2000 },
			});

			const results = { fast: { success: 0, failed: 0 }, slow: { success: 0, failed: 0 } };
			const latencies: number[] = [];
			const errors: Record<string, number> = {};
			const promises: Promise<void>[] = [];

			const startTime = performance.now();

			for (let i = 0; i < 100; i++) {
				const isFast = i % 2 === 0;
				const baseUrl = isFast ? fastServer.baseUrl : slowServer.baseUrl;
				const target = isFast ? "fast" : "slow";
				const start = performance.now();

				promises.push(
					client
						.get(`${baseUrl}/test/${i}`)
						.toPromise()
						.then((result) => {
							latencies.push(performance.now() - start);
							if (result.success) {
								results[target].success++;
							} else {
								results[target].failed++;
								const errorKey = result.error.constructor.name;
								errors[errorKey] = (errors[errorKey] ?? 0) + 1;
							}
						}),
				);
			}

			await Promise.allSettled(promises);
			const durationMs = performance.now() - startTime;

			const totalSuccess = results.fast.success + results.slow.success;
			const totalFailed = results.fast.failed + results.slow.failed;

			latencies.sort((a, b) => a - b);
			const avgLatencyMs = latencies.reduce((sum, val) => sum + val, 0) / latencies.length || 0;

			return {
				name: "Bulkhead Isolation",
				totalRequests: 100,
				successfulRequests: totalSuccess,
				failedRequests: totalFailed,
				avgLatencyMs,
				p50LatencyMs: calculatePercentile(latencies, 50),
				p95LatencyMs: calculatePercentile(latencies, 95),
				p99LatencyMs: calculatePercentile(latencies, 99),
				minLatencyMs: latencies[0] ?? 0,
				maxLatencyMs: latencies[latencies.length - 1] ?? 0,
				requestsPerSecond: 100 / (durationMs / 1000),
				durationMs,
				errors,
				timestamp: new Date().toISOString(),
			};
		} finally {
			await Promise.all([fastServer.stop(), slowServer.stop()]);
		}
	},

	"Retry Storm": async () => {
		const server = new TestServer({
			baseLatencyMs: 10,
			jitterMs: 5,
			failRate: 0.8, // High failure rate to trigger many retries
			statusCodes: [503],
		});
		await server.start();

		try {
			const client = HttpClient.create({
				baseUrl: server.baseUrl,
				retry: {
					maxRetries: 3,
					backoff: {
						baseDelayMs: 100,
						maxDelayMs: 5000,
						jitter: true,
					},
				},
				timeout: { attemptMs: 3000 },
				concurrency: 50,
			});

			const totalRequests = 100;
			const latencies: number[] = [];
			const errors: Record<string, number> = {};
			let successful = 0;
			let failed = 0;

			client.on("retry", () => {
				// Track retries for analysis (not included in result)
			});

			const startTime = performance.now();
			const promises: Promise<void>[] = [];

			for (let i = 0; i < totalRequests; i++) {
				const start = performance.now();
				const promise = client
					.get(`/storm/${i}`)
					.toPromise()
					.then((result) => {
						const latency = performance.now() - start;
						latencies.push(latency);

						if (result.success) {
							successful++;
						} else {
							failed++;
							const errorKey = result.error.constructor.name;
							errors[errorKey] = (errors[errorKey] ?? 0) + 1;
						}
					});

				promises.push(promise);
			}

			await Promise.allSettled(promises);
			const endTime = performance.now();
			const durationMs = endTime - startTime;

			latencies.sort((a, b) => a - b);
			const avgLatencyMs = latencies.reduce((sum, val) => sum + val, 0) / latencies.length || 0;

			const calculatePercentile = (p: number): number => {
				if (latencies.length === 0) return 0;
				const index = Math.ceil((p / 100) * latencies.length) - 1;
				return latencies[Math.max(0, index)];
			};

			return {
				name: "Retry Storm",
				totalRequests,
				successfulRequests: successful,
				failedRequests: failed,
				avgLatencyMs,
				p50LatencyMs: calculatePercentile(50),
				p95LatencyMs: calculatePercentile(95),
				p99LatencyMs: calculatePercentile(99),
				minLatencyMs: latencies[0] ?? 0,
				maxLatencyMs: latencies[latencies.length - 1] ?? 0,
				requestsPerSecond: totalRequests / (durationMs / 1000),
				durationMs,
				errors,
				timestamp: new Date().toISOString(),
			};
		} finally {
			await server.stop();
		}
	},

	"Thundering Herd": async () => {
		const server = new TestServer({ baseLatencyMs: 10, jitterMs: 5 });
		await server.start();

		try {
			const client = HttpClient.create({
				baseUrl: server.baseUrl,
				retry: { maxRetries: 2 },
				timeout: { attemptMs: 5000 },
				concurrency: 20,
				// Global and partition queues are both sized to absorb the whole burst
				// (200 minus each level's concurrency), so the thresholds measure
				// queueing latency, not load shedding. Bulkhead Isolation covers shedding.
				maxQueueSize: 180,
				partitions: {
					[server.baseUrl.replace("http://", "")]: {
						concurrency: 10,
						maxQueueSize: 190,
					},
				},
			});

			// Simulate idle period
			await new Promise((resolve) => setTimeout(resolve, 2000));

			// Suddenly fire all requests at once
			const totalRequests = 200;
			const latencies: number[] = [];
			const errors: Record<string, number> = {};
			let successful = 0;
			let failed = 0;

			const startTime = performance.now();
			const promises: Promise<void>[] = [];

			for (let i = 0; i < totalRequests; i++) {
				const start = performance.now();
				const promise = client
					.get(`/herd/${i}`)
					.toPromise()
					.then((result) => {
						const latency = performance.now() - start;
						latencies.push(latency);

						if (result.success) {
							successful++;
						} else {
							failed++;
							const errorKey = result.error.constructor.name;
							errors[errorKey] = (errors[errorKey] ?? 0) + 1;
						}
					});

				promises.push(promise);
			}

			await Promise.allSettled(promises);
			const endTime = performance.now();
			const durationMs = endTime - startTime;

			latencies.sort((a, b) => a - b);
			const avgLatencyMs = latencies.reduce((sum, val) => sum + val, 0) / latencies.length || 0;

			const calculatePercentile = (p: number): number => {
				if (latencies.length === 0) return 0;
				const index = Math.ceil((p / 100) * latencies.length) - 1;
				return latencies[Math.max(0, index)];
			};

			return {
				name: "Thundering Herd",
				totalRequests,
				successfulRequests: successful,
				failedRequests: failed,
				avgLatencyMs,
				p50LatencyMs: calculatePercentile(50),
				p95LatencyMs: calculatePercentile(95),
				p99LatencyMs: calculatePercentile(99),
				minLatencyMs: latencies[0] ?? 0,
				maxLatencyMs: latencies[latencies.length - 1] ?? 0,
				requestsPerSecond: totalRequests / (durationMs / 1000),
				durationMs,
				errors,
				timestamp: new Date().toISOString(),
			};
		} finally {
			await server.stop();
		}
	},
};

// Pass/fail gates per benchmark, used to give the suite a non-zero exit code
// when performance regresses. Benchmarks with intentionally high injected
// failure rates (Retry Storm, Network Chaos) get looser success-rate floors.
const benchmarkThresholds: Record<string, Thresholds> = {
	"Basic Load Test": { minSuccessRate: 0.95, maxP95LatencyMs: 100, maxP99LatencyMs: 200 },
	"Stress Test (Low Concurrency)": { minSuccessRate: 0.9, maxP95LatencyMs: 250, maxP99LatencyMs: 500 },
	"Stress Test (High Concurrency)": { minSuccessRate: 0.85, maxP95LatencyMs: 500, maxP99LatencyMs: 1000 },
	"Network Chaos (30% failures)": { minSuccessRate: 0.9 },
	"Retry Storm": { minSuccessRate: 0.5 },
	"Thundering Herd": { minSuccessRate: 0.9, maxP99LatencyMs: 2000 },
};

async function runAllBenchmarks(selectedBenchmarks?: string[]) {
	console.log(`\n${"=".repeat(60)}`);
	console.log("VEREDA BENCHMARK SUITE");
	console.log(`${"=".repeat(60)}\n`);

	const toRun =
		selectedBenchmarks && selectedBenchmarks.length > 0
			? Object.entries(benchmarks).filter(([name]) =>
					selectedBenchmarks.some((s) => name.toLowerCase().includes(s.toLowerCase())),
				)
			: Object.entries(benchmarks);

	const results: BenchmarkResult[] = [];
	const allViolations: { benchmark: string; metric: string; limit: number; actual: number }[] = [];

	for (const [name, fn] of toRun) {
		console.log(`\n▶ Running: ${name}`);
		try {
			const result = await fn();
			results.push(result);
			printResults(result);

			const thresholds = benchmarkThresholds[name];
			if (thresholds) {
				const violations = checkThresholds(result, thresholds);
				if (violations.length > 0) {
					console.error(`✗ Threshold violations for ${name}:`);
					for (const v of violations) {
						console.error(`  ${v.metric}: limit ${v.limit}, got ${v.actual.toFixed(2)}`);
						allViolations.push({ benchmark: name, ...v });
					}
				}
			}
		} catch (error) {
			console.error(`✗ Failed: ${name}`);
			console.error(error);
		}
	}

	// Generate summary
	generateSummary(results);

	const resultsFile = await saveResults(results);
	console.log(`Results saved to: ${resultsFile}`);

	if (allViolations.length > 0) {
		console.error(`\n${allViolations.length} threshold violation(s) detected across ${toRun.length} benchmark(s).`);
		process.exit(1);
	}
}

function generateSummary(results: BenchmarkResult[]): void {
	console.log(`\n${"=".repeat(60)}`);
	console.log("SUMMARY REPORT");
	console.log("=".repeat(60));
	console.log(`Total Benchmarks: ${results.length}`);
	console.log(`Timestamp: ${new Date().toISOString()}`);
	console.log("-".repeat(60));

	console.log("\nPerformance Overview:\n");
	console.table(
		results.map((r) => ({
			Benchmark: r.name,
			"Req/s": r.requestsPerSecond.toFixed(1),
			"Avg (ms)": r.avgLatencyMs.toFixed(1),
			"P95 (ms)": r.p95LatencyMs.toFixed(1),
			"P99 (ms)": r.p99LatencyMs.toFixed(1),
			"Success %": `${((r.successfulRequests / r.totalRequests) * 100).toFixed(1)}%`,
		})),
	);

	// Find best and worst performers
	if (results.length > 0) {
		const byThroughput = [...results].sort((a, b) => b.requestsPerSecond - a.requestsPerSecond);
		const byLatency = [...results].sort((a, b) => a.p95LatencyMs - b.p95LatencyMs);
		const byReliability = [...results].sort(
			(a, b) => (b.successfulRequests / b.totalRequests) * 100 - (a.successfulRequests / a.totalRequests) * 100,
		);

		console.log("\nKey Insights:");
		console.log(
			`  Highest Throughput: ${byThroughput[0].name} (${byThroughput[0].requestsPerSecond.toFixed(1)} req/s)`,
		);
		console.log(`  Lowest P95 Latency: ${byLatency[0].name} (${byLatency[0].p95LatencyMs.toFixed(1)}ms)`);
		console.log(
			`  Most Reliable: ${byReliability[0].name} (${((byReliability[0].successfulRequests / byReliability[0].totalRequests) * 100).toFixed(1)}% success)`,
		);
	}

	console.log(`\n${"=".repeat(60)}\n`);
}

// CLI argument parsing
const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
	console.log(`
Vereda Benchmark Runner

Usage:
  bun run src/runner.ts              # Run all benchmarks
  bun run src/runner.ts stress       # Run benchmarks matching 'stress'
  bun run src/runner.ts chaos        # Run benchmarks matching 'chaos'

Examples:
  bun run src/runner.ts load         # Run load tests
  bun run src/runner.ts scenario     # Run scenario tests
`);
	process.exit(0);
}

runAllBenchmarks(args).catch(console.error);
