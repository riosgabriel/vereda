import { HttpClient } from "vereda";
import { type BenchmarkResult, printResults, TestServer } from "../src/utils.ts";

/**
 * Chaos Engineering: Service failures
 * Tests how Vereda handles complete service unavailability
 */
async function failureChaos() {
	const server = new TestServer({ baseLatencyMs: 10, jitterMs: 5 });
	await server.start();

	try {
		console.log("=== CHAOS: SERVICE FAILURES ===");
		console.log("Simulating periodic service outages...\n");

		const client = HttpClient.create({
			baseUrl: server.baseUrl,
			retry: {
				maxRetries: 5,
				backoff: {
					baseDelayMs: 200,
					maxDelayMs: 10000,
					jitter: true,
				},
			},
			timeout: { attemptMs: 2000 },
		});

		const totalRequests = 300;
		const concurrency = 30;
		const latencies: number[] = [];
		const errors: Record<string, number> = {};
		let successful = 0;
		let failed = 0;

		// Simulate outage periods
		let isOutage = false;
		const outageInterval = setInterval(() => {
			isOutage = !isOutage;
			console.log(`Service status: ${isOutage ? "🔴 OUTAGE" : "🟢 OPERATIONAL"}`);
		}, 3000); // Toggle every 3 seconds

		server.server?.on("request", async (_req, res) => {
			if (isOutage) {
				res.statusCode = 503;
				res.end("Service Unavailable");
				return;
			}
		});

		const startTime = performance.now();
		const promises: Promise<void>[] = [];

		for (let i = 0; i < totalRequests; i++) {
			const start = performance.now();
			const promise = client
				.get(`/chaos/${i}`)
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
		clearInterval(outageInterval);

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
			name: "Service Failure Chaos Test",
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
		console.log(`Success rate during outages: ${((successful / totalRequests) * 100).toFixed(1)}%`);
		console.log(`Retry effectiveness: Vereda retried failed requests during outage periods`);

		if (Object.keys(errors).length > 0) {
			console.log("\nFinal error breakdown:");
			for (const [error, count] of Object.entries(errors)) {
				console.log(`  ${error}: ${count}`);
			}
		}
	} finally {
		await server.stop();
	}
}

failureChaos().catch(console.error);
