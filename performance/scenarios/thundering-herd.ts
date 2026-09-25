import { HttpClient } from "vereda";
import { type BenchmarkResult, printResults, TestServer } from "../src/utils.ts";

/**
 * Scenario: Thundering herd test
 * Tests what happens when many requests start simultaneously after a period of inactivity
 * This is a classic distributed systems problem
 */
async function thunderingHerdScenario() {
	const server = new TestServer({ baseLatencyMs: 10, jitterMs: 5 });
	await server.start();

	try {
		console.log("=== SCENARIO: THUNDERING HERD ===");
		console.log("Simulating sudden burst of requests after idle period...\n");

		const client = HttpClient.create({
			baseUrl: server.baseUrl,
			retry: { maxRetries: 2 },
			timeout: { attemptMs: 5000 },
			concurrency: 20, // Limit concurrent requests
			partitions: {
				[server.baseUrl.replace("http://", "")]: {
					concurrency: 10,
					maxQueueSize: 100,
				},
			},
		});

		// Simulate idle period
		console.log("Idle period (2s)...");
		await new Promise((resolve) => setTimeout(resolve, 2000));

		// Suddenly fire all requests at once
		const totalRequests = 200;
		const latencies: number[] = [];
		const errors: Record<string, number> = {};
		let successful = 0;
		let failed = 0;
		const queueTimes: number[] = [];

		client.on("request", () => {
			queueTimes.push(performance.now());
		});

		console.log(`Firing ${totalRequests} requests simultaneously...`);
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

		const result: BenchmarkResult = {
			name: "Thundering Herd Scenario",
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

		// Check if queuing helped manage the burst
		const firstBatch = latencies.slice(0, 20); // First 20 (concurrency limit)
		const restBatch = latencies.slice(20);

		const firstBatchAvg = firstBatch.reduce((sum, val) => sum + val, 0) / firstBatch.length || 0;
		const restBatchAvg = restBatch.reduce((sum, val) => sum + val, 0) / restBatch.length || 0;

		console.log(`First batch (immediate, n=20) avg: ${firstBatchAvg.toFixed(0)}ms`);
		console.log(`Queued batch (n=${restBatch.length}) avg: ${restBatchAvg.toFixed(0)}ms`);
		console.log(`Queue overhead: ${(restBatchAvg - firstBatchAvg).toFixed(0)}ms`);

		if (failed === 0) {
			console.log("\n✓ All requests completed successfully");
			console.log("✓ Bulkhead queue managed the burst without dropping requests");
		} else {
			console.log(`\n⚠️  ${failed} requests failed during burst`);
			if (Object.keys(errors).length > 0) {
				console.log("Error breakdown:");
				for (const [error, count] of Object.entries(errors)) {
					console.log(`  ${error}: ${count}`);
				}
			}
		}

		// Check for p99 spike
		const p99ToP50Ratio = result.p99LatencyMs / result.p50LatencyMs;
		if (p99ToP50Ratio > 5) {
			console.warn(`\n⚠️  High tail latency variance (p99/p50 ratio: ${p99ToP50Ratio.toFixed(1)})`);
			console.warn("   Queued requests experienced significantly higher latency");
		} else {
			console.log("\n✓ Tail latency well-controlled despite burst");
		}
	} finally {
		await server.stop();
	}
}

thunderingHerdScenario().catch(console.error);
