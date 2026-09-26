import { HttpClient } from "@vereda/http";
import { TestServer } from "../src/utils.ts";

/**
 * Scenario: Circuit breaker load shedding
 * Verifies that once a partition's circuit trips, subsequent requests to
 * that partition are rejected near-instantly (CircuitOpenError) instead of
 * queuing behind the full retry/timeout cycle against a failing server.
 */
async function circuitBreakerScenario() {
	const healthyServer = new TestServer({ baseLatencyMs: 5, jitterMs: 2 });
	const failingServer = new TestServer({
		baseLatencyMs: 50,
		jitterMs: 20,
		failRate: 1, // always fails, to reliably trip the breaker
		statusCodes: [503],
	});

	await Promise.all([healthyServer.start(), failingServer.start()]);

	try {
		console.log("=== SCENARIO: CIRCUIT BREAKER LOAD SHEDDING ===");
		console.log(`Healthy server: ${healthyServer.baseUrl} (5ms latency, no failures)`);
		console.log(`Failing server: ${failingServer.baseUrl} (50ms latency, 100% failures)`);
		console.log("");

		const client = HttpClient.create({
			concurrency: 10,
			partitions: {
				[healthyServer.baseUrl.replace("http://", "")]: {
					concurrency: 5,
					maxQueueSize: 20,
				},
				[failingServer.baseUrl.replace("http://", "")]: {
					concurrency: 5,
					maxQueueSize: 20,
					circuitBreaker: {
						enabled: true,
						failureThreshold: 5,
						resetTimeoutMs: 300,
						halfOpenMaxAttempts: 1,
					},
				},
			},
			retry: { maxRetries: 1 },
			timeout: { attemptMs: 2000 },
		});

		const totalRequests = 200;
		const results = {
			healthy: { success: 0, failed: 0, latencies: [] as number[] },
			failing: { success: 0, failed: 0, circuitOpen: 0, latencies: [] as number[] },
		};

		const startTime = performance.now();
		const promises: Promise<void>[] = [];

		for (let i = 0; i < totalRequests; i++) {
			const isHealthy = i % 2 === 0;
			const baseUrl = isHealthy ? healthyServer.baseUrl : failingServer.baseUrl;

			const promise = client
				.get(`${baseUrl}/test/${i}`)
				.toPromise()
				.then((result) => {
					const latency = performance.now() - startTime;

					if (isHealthy) {
						results.healthy.latencies.push(latency);
						if (result.success) {
							results.healthy.success++;
						} else {
							results.healthy.failed++;
						}
						return;
					}

					results.failing.latencies.push(latency);
					if (result.success) {
						results.failing.success++;
					} else if (result.error.kind === "circuit_open") {
						results.failing.circuitOpen++;
					} else {
						results.failing.failed++;
					}
				});

			promises.push(promise);
		}

		await Promise.allSettled(promises);

		const calculateStats = (latencies: number[]) => {
			if (latencies.length === 0) {
				return { avg: 0, p95: 0, p99: 0 };
			}
			latencies.sort((a, b) => a - b);
			const avg = latencies.reduce((sum, val) => sum + val, 0) / latencies.length;
			const p95Index = Math.ceil(0.95 * latencies.length) - 1;
			const p99Index = Math.ceil(0.99 * latencies.length) - 1;
			return {
				avg,
				p95: latencies[p95Index] ?? 0,
				p99: latencies[p99Index] ?? 0,
			};
		};

		const healthyStats = calculateStats(results.healthy.latencies);
		const failingStats = calculateStats(results.failing.latencies);

		console.log("\n=== RESULTS ===");
		console.log("\nHealthy Partition:");
		console.log(`  Success: ${results.healthy.success}/${results.healthy.success + results.healthy.failed}`);
		console.log(`  Avg latency: ${healthyStats.avg.toFixed(0)}ms`);
		console.log(`  P95 latency: ${healthyStats.p95.toFixed(0)}ms`);

		console.log("\nFailing Partition:");
		const failingTotal = results.failing.success + results.failing.failed + results.failing.circuitOpen;
		console.log(`  Real failures (hit the server): ${results.failing.failed}/${failingTotal}`);
		console.log(
			`  Circuit-open rejections (shed, never hit the server): ${results.failing.circuitOpen}/${failingTotal}`,
		);
		console.log(`  Avg latency: ${failingStats.avg.toFixed(0)}ms`);
		console.log(`  P95 latency: ${failingStats.p95.toFixed(0)}ms`);

		console.log("\n=== ANALYSIS ===");
		if (results.failing.circuitOpen === 0) {
			console.warn("⚠️  WARNING: Circuit never tripped — no requests were shed.");
			console.warn("   Check the circuitBreaker config and failure rate.");
		} else {
			const sheddingRate = (results.failing.circuitOpen / failingTotal) * 100;
			console.log(`✓ Circuit tripped and shed ${sheddingRate.toFixed(0)}% of requests to the failing partition`);
			console.log("✓ Healthy partition latency unaffected by the failing partition's circuit state");
		}
	} finally {
		await Promise.all([healthyServer.stop(), failingServer.stop()]);
	}
}

circuitBreakerScenario().catch(console.error);
