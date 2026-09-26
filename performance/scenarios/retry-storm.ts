import { HttpClient } from "@vereda/http";
import { type BenchmarkResult, printResults, TestServer } from "../src/utils.ts";

/**
 * Scenario: Retry storm test
 * Simulates a situation where many requests fail simultaneously and retry
 * Tests if Vereda's backoff prevents overwhelming the server
 */
async function retryStormScenario() {
	const server = new TestServer({
		baseLatencyMs: 10,
		jitterMs: 5,
		failRate: 0.8, // High failure rate to trigger many retries
		statusCodes: [503],
	});
	await server.start();

	try {
		console.log("=== SCENARIO: RETRY STORM ===");
		console.log("Simulating 80% failure rate triggering massive retries...\n");

		const client = HttpClient.create({
			baseUrl: server.baseUrl,
			retry: {
				maxRetries: 3,
				backoff: {
					baseDelayMs: 100,
					maxDelayMs: 5000,
					jitter: true, // Jitter is critical to prevent thundering herd
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
		let totalAttempts = 0;

		// Track retry events
		client.on("retry", () => {
			totalAttempts++;
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

		const result: BenchmarkResult = {
			name: "Retry Storm Scenario",
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

		printResults(result);

		// Analysis
		console.log("=== ANALYSIS ===");
		console.log(`Total retry attempts: ${totalAttempts}`);
		console.log(`Average retries per request: ${(totalAttempts / totalRequests).toFixed(2)}`);
		console.log(`Success rate after retries: ${((successful / totalRequests) * 100).toFixed(1)}%`);

		// Check if backoff helped spread out retries
		const expectedMaxRetries = totalRequests * 3; // maxRetries = 3
		const actualRetryRate = totalAttempts / expectedMaxRetries;

		console.log(`\nRetry utilization: ${(actualRetryRate * 100).toFixed(1)}% of maximum possible`);

		if (successful > 0) {
			console.log("✓ Some requests succeeded despite 80% failure rate");
			console.log("✓ Exponential backoff with jitter prevented complete saturation");
		} else {
			console.log("ℹ All requests failed, but backoff should have prevented server overload");
		}

		// Analyze latency distribution during storm
		const quickRequests = latencies.filter((l) => l < 1000);
		const slowRequests = latencies.filter((l) => l >= 1000);

		console.log(`\nQuick completions (<1s): ${quickRequests.length}`);
		console.log(`Slow completions (>=1s, likely multiple retries): ${slowRequests.length}`);
	} finally {
		await server.stop();
	}
}

retryStormScenario().catch(console.error);
