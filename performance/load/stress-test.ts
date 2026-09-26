import { HttpClient } from "@vereda/http";
import { printResults, runBenchmark, TestServer } from "../src/utils.ts";

/**
 * Stress test: Push the system beyond normal capacity to find breaking points
 */
async function stressTest() {
	const server = new TestServer({ baseLatencyMs: 20, jitterMs: 10 });
	await server.start();

	try {
		console.log("=== STRESS TEST ===");
		console.log("Testing different concurrency levels to find limits...\n");

		const concurrencyLevels = [10, 50, 100, 200, 500];

		for (const concurrency of concurrencyLevels) {
			const client = HttpClient.create({
				baseUrl: server.baseUrl,
				retry: { maxRetries: 2 },
				timeout: { attemptMs: 3000 },
				concurrency: Math.min(concurrency * 2, 1000),
			});

			const result = await runBenchmark(client, {
				name: `Stress Test (concurrency: ${concurrency})`,
				totalRequests: 1000,
				concurrency,
				warmupRequests: 20,
			});

			printResults(result);
		}
	} finally {
		await server.stop();
	}
}

stressTest().catch(console.error);
