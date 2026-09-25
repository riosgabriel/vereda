import { HttpClient } from "vereda";
import { type BenchmarkResult, printResults, TestServer } from "../src/utils.ts";

/**
 * Chaos Engineering: Network failures
 * Tests how Vereda handles random network errors
 */
async function networkChaos() {
	const server = new TestServer({
		baseLatencyMs: 10,
		jitterMs: 5,
		failRate: 0.3, // 30% failure rate
		statusCodes: [500, 502, 503, 504],
	});
	await server.start();

	try {
		console.log("=== CHAOS: NETWORK FAILURES ===");
		console.log("Simulating 30% random network failures...\n");

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
		});

		const totalRequests = 200;
		const concurrency = 20;
		const latencies: number[] = [];
		const errors: Record<string, number> = {};
		let successful = 0;
		let failed = 0;

		const startTime = performance.now();
		const promises: Promise<void>[] = [];

		for (let i = 0; i < totalRequests; i++) {
			const start = performance.now();
			const promise = client
				.get(`/chaos/${i}`, {})
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

			if (promises.length >= concurrency) {
				await Promise.allSettled(promises);
				promises.length = 0;
			}
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
			name: "Network Chaos Test",
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
		console.log(
			`Retry effectiveness: ${((successful / totalRequests) * 100).toFixed(1)}% success despite 30% failure rate`,
		);

		if (failed > 0) {
			console.log("\nFailure breakdown:");
			for (const [error, count] of Object.entries(errors)) {
				console.log(`  ${error}: ${count}`);
			}
		}
	} finally {
		await server.stop();
	}
}

networkChaos().catch(console.error);
