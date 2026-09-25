import { HttpClient } from "vereda";
import { printResults, runBenchmark, TestServer } from "../src/utils.ts";

async function basicLoadTest() {
	const server = new TestServer({ baseLatencyMs: 10, jitterMs: 5 });
	await server.start();

	try {
		const client = HttpClient.create({
			baseUrl: server.baseUrl,
			retry: { maxRetries: 3 },
			timeout: { attemptMs: 5000 },
		});

		const result = await runBenchmark(client, {
			name: "Basic Load Test",
			totalRequests: 500,
			concurrency: 20,
			warmupRequests: 50,
		});

		printResults(result);
	} finally {
		await server.stop();
	}
}

basicLoadTest().catch(console.error);
