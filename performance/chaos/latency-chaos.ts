import { HttpClient } from "vereda";
import { type BenchmarkResult, printResults, TestServer } from "../src/utils.ts";

/**
 * Chaos Engineering: Latency spikes
 * Tests how Vereda handles sudden latency increases
 */
async function latencyChaos() {
	const server = new TestServer({
		baseLatencyMs: 10,
		jitterMs: 5,
		// 20% of requests get a 500-2000ms spike before the normal response.
		intercept: async () => {
			if (Math.random() < 0.2) {
				const spikeLatency = 500 + Math.random() * 1500;
				await new Promise((r) => setTimeout(r, spikeLatency));
			}
			return false;
		},
	});
	await server.start();

	try {
		console.log("=== CHAOS: LATENCY SPIKES ===");
		console.log("Simulating random latency spikes (10ms -> 500-2000ms)...\n");

		const client = HttpClient.create({
			baseUrl: server.baseUrl,
			retry: { maxRetries: 2 },
			timeout: { attemptMs: 5000 },
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
		const endTime = performance.now();
		const durationMs = endTime - startTime;

		latencies.sort((a, b) => a - b);
		const avgLatencyMs = latencies.reduce((sum, val) => sum + val, 0) / latencies.length || 0;

		const calculatePercentile = (p: number): number => {
			if (latencies.length === 0) return 0;
			const index = Math.ceil((p / 100) * latencies.length) - 1;
			return latencies[Math.max(0, index)];
		};

		// Analyze latency distribution
		const normalLatencies = latencies.filter((l) => l < 100);
		const spikedLatencies = latencies.filter((l) => l >= 100);

		const result: BenchmarkResult = {
			name: "Latency Chaos Test",
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
		console.log(`Normal requests (<100ms): ${normalLatencies.length}`);
		console.log(`Spiked requests (>=100ms): ${spikedLatencies.length}`);
		console.log(`Timeout rate: ${((failed / totalRequests) * 100).toFixed(1)}%`);

		if (spikedLatencies.length > 0) {
			const avgSpikeLatency = spikedLatencies.reduce((sum, val) => sum + val, 0) / spikedLatencies.length;
			console.log(`Average spiked latency: ${avgSpikeLatency.toFixed(0)}ms`);
		}
	} finally {
		await server.stop();
	}
}

latencyChaos().catch(console.error);
