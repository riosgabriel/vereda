import { HttpClient } from "@vereda/http";
import { TestServer } from "../src/utils.ts";

/**
 * Scenario: Bulkhead isolation test
 * Verifies that failures in one partition don't affect others
 */
async function bulkheadScenario() {
	// Create two servers: one fast/reliable, one slow/unreliable
	const fastServer = new TestServer({ baseLatencyMs: 5, jitterMs: 2 });
	const slowServer = new TestServer({
		baseLatencyMs: 100,
		jitterMs: 50,
		failRate: 0.5,
		statusCodes: [500, 503],
	});

	await Promise.all([fastServer.start(), slowServer.start()]);

	try {
		console.log("=== SCENARIO: BULKHEAD ISOLATION ===");
		console.log(`Fast server: ${fastServer.baseUrl} (5ms latency)`);
		console.log(`Slow server: ${slowServer.baseUrl} (100ms + 50% failures)`);
		console.log("");

		const totalRequests = 200;

		const client = HttpClient.create({
			concurrency: 10, // Global limit
			maxQueueSize: totalRequests, // Comfortably exceed the burst so global queueing doesn't mask partition behavior
			partitions: {
				[fastServer.baseUrl.replace("http://", "")]: {
					concurrency: 5,
					maxQueueSize: 20,
				},
				[slowServer.baseUrl.replace("http://", "")]: {
					concurrency: 2, // Limited concurrency for slow server
					maxQueueSize: 10,
				},
			},
			retry: { maxRetries: 2 },
			timeout: { attemptMs: 2000 },
		});

		const results = {
			fast: { success: 0, failed: 0, latencies: [] as number[] },
			slow: { success: 0, failed: 0, latencies: [] as number[] },
		};

		const startTime = performance.now();

		// Send requests to both servers concurrently
		const promises: Promise<void>[] = [];

		for (let i = 0; i < totalRequests; i++) {
			const isFast = i % 2 === 0;
			const baseUrl = isFast ? fastServer.baseUrl : slowServer.baseUrl;
			const target = isFast ? "fast" : "slow";

			const promise = client
				.get(`${baseUrl}/test/${i}`)
				.toPromise()
				.then((result) => {
					const latency = performance.now() - startTime;
					results[target].latencies.push(latency);

					if (result.success) {
						results[target].success++;
					} else {
						results[target].failed++;
					}
				});

			promises.push(promise);
		}

		await Promise.allSettled(promises);
		const endTime = performance.now();
		const _durationMs = endTime - startTime;

		// Calculate statistics for each partition
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

		const fastStats = calculateStats(results.fast.latencies);
		const slowStats = calculateStats(results.slow.latencies);

		console.log("\n=== RESULTS ===");
		console.log("\nFast Partition:");
		console.log(`  Success: ${results.fast.success}/${results.fast.success + results.fast.failed}`);
		console.log(`  Avg latency: ${fastStats.avg.toFixed(0)}ms`);
		console.log(`  P95 latency: ${fastStats.p95.toFixed(0)}ms`);
		console.log(`  P99 latency: ${fastStats.p99.toFixed(0)}ms`);

		console.log("\nSlow/Failing Partition:");
		console.log(`  Success: ${results.slow.success}/${results.slow.success + results.slow.failed}`);
		console.log(`  Avg latency: ${slowStats.avg.toFixed(0)}ms`);
		console.log(`  P95 latency: ${slowStats.p95.toFixed(0)}ms`);
		console.log(`  P99 latency: ${slowStats.p99.toFixed(0)}ms`);

		console.log("\n=== ANALYSIS ===");

		// Note: first attempts bypass the per-partition bulkhead unless
		// `limitFirstAttempts` is set (it defaults to false) — see
		// PartitionConfig.limitFirstAttempts in src/core/types.ts. Neither
		// partition sets it here, so this scenario currently measures
		// global-semaphore fairness, not per-partition concurrency isolation,
		// on the happy path. An absolute latency ceiling was tried here
		// previously and removed: it compared a per-request service-time
		// constant against time-since-batch-start over a 100-request queue,
		// which no concurrency setting can satisfy.
		if (results.fast.failed > 0) {
			console.warn(
				`⚠️  WARNING: Fast partition had ${results.fast.failed} failure(s) — should be 0 (its server has 0% failRate).`,
			);
			console.warn("   The slow/failing partition is contaminating the fast partition's outcomes.");
		} else if (fastStats.avg >= slowStats.avg) {
			console.warn(
				`⚠️  WARNING: Fast partition latency (${fastStats.avg.toFixed(0)}ms) is not lower than the slow partition's (${slowStats.avg.toFixed(0)}ms).`,
			);
		} else {
			console.log("✓ Fast partition had zero failures despite the slow/failing partition");
			console.log(
				`✓ Fast partition stayed faster than slow (${fastStats.avg.toFixed(0)}ms vs ${slowStats.avg.toFixed(0)}ms)`,
			);
		}

		// Verify queue behavior
		const totalFailed = results.fast.failed + results.slow.failed;
		console.log(
			`\nTotal failures: ${totalFailed}/${totalRequests} (${((totalFailed / totalRequests) * 100).toFixed(1)}%)`,
		);
	} finally {
		await Promise.all([fastServer.stop(), slowServer.stop()]);
	}
}

bulkheadScenario().catch(console.error);
