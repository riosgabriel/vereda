import { HttpClient } from "vereda";
import { type BenchmarkResult, printResults, TestServer } from "../src/utils.ts";

/**
 * Soak test: Run sustained load over time to detect memory leaks and degradation
 */
async function soakTest() {
	const server = new TestServer({ baseLatencyMs: 15, jitterMs: 5 });
	await server.start();

	try {
		console.log("=== SOAK TEST ===");
		console.log("Running sustained load for extended period...\n");

		const client = HttpClient.create({
			baseUrl: server.baseUrl,
			retry: { maxRetries: 2 },
			timeout: { attemptMs: 5000 },
			concurrency: 50,
		});

		const durationMs = 60_000; // 1 minute (increase for real soak tests)
		const requestsPerSecond = 20;
		const intervalMs = 1000 / requestsPerSecond;

		let totalRequests = 0;
		let successfulRequests = 0;
		let failedRequests = 0;
		const latencies: number[] = [];
		const errors: Record<string, number> = {};

		const startTime = performance.now();
		const intervals: NodeJS.Timeout[] = [];

		// Track progress
		const progressInterval = setInterval(() => {
			const elapsed = performance.now() - startTime;
			console.log(
				`Progress: ${Math.round(elapsed / 1000)}s - ${totalRequests} requests (${successfulRequests} success, ${failedRequests} failed)`,
			);
		}, 5000);

		// Start sending requests at constant rate
		const sendRequest = async () => {
			const start = performance.now();
			const result = await client.get(`/soak/${totalRequests}`, {}).toPromise();
			const latency = performance.now() - start;
			latencies.push(latency);
			totalRequests++;

			if (result.success) {
				successfulRequests++;
			} else {
				failedRequests++;
				const errorKey = result.error.constructor.name;
				errors[errorKey] = (errors[errorKey] ?? 0) + 1;
			}
		};

		const requestInterval = setInterval(() => {
			sendRequest().catch(console.error);
		}, intervalMs);

		intervals.push(requestInterval, progressInterval);

		// Wait for duration
		await new Promise((resolve) => setTimeout(resolve, durationMs));

		// Cleanup
		intervals.forEach((i) => void clearInterval(i));
		clearInterval(progressInterval);

		// Calculate results
		latencies.sort((a, b) => a - b);
		const avgLatencyMs = latencies.reduce((sum, val) => sum + val, 0) / latencies.length || 0;

		const calculatePercentile = (p: number): number => {
			if (latencies.length === 0) return 0;
			const index = Math.ceil((p / 100) * latencies.length) - 1;
			return latencies[Math.max(0, index)];
		};

		const result: BenchmarkResult = {
			name: "Soak Test",
			totalRequests,
			successfulRequests,
			failedRequests,
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

		// Check for degradation
		const firstHalf = latencies.slice(0, Math.floor(latencies.length / 2));
		const secondHalf = latencies.slice(Math.floor(latencies.length / 2));

		const firstHalfAvg = firstHalf.reduce((sum, val) => sum + val, 0) / firstHalf.length || 0;
		const secondHalfAvg = secondHalf.reduce((sum, val) => sum + val, 0) / secondHalf.length || 0;

		const degradation = ((secondHalfAvg - firstHalfAvg) / firstHalfAvg) * 100;

		console.log("\n=== DEGRADATION ANALYSIS ===");
		console.log(`First half avg latency:  ${firstHalfAvg.toFixed(2)}ms`);
		console.log(`Second half avg latency: ${secondHalfAvg.toFixed(2)}ms`);
		console.log(`Degradation: ${degradation >= 0 ? "+" : ""}${degradation.toFixed(2)}%`);

		if (degradation > 10) {
			console.warn("⚠️  WARNING: Significant performance degradation detected!");
		}
	} finally {
		await server.stop();
	}
}

soakTest().catch(console.error);
