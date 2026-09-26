import type { IncomingMessage, ServerResponse } from "node:http";
import type { HttpClient } from "@vereda/http";

export interface BenchmarkResult {
	name: string;
	totalRequests: number;
	successfulRequests: number;
	failedRequests: number;
	avgLatencyMs: number;
	p50LatencyMs: number;
	p95LatencyMs: number;
	p99LatencyMs: number;
	minLatencyMs: number;
	maxLatencyMs: number;
	requestsPerSecond: number;
	durationMs: number;
	errors: Record<string, number>;
	timestamp: string;
}

export interface BenchmarkOptions {
	name: string;
	concurrency?: number;
	totalRequests?: number;
	rps?: number; // requests per second (for constant load)
	durationMs?: number; // for soak tests
	warmupRequests?: number;
}

/**
 * Runs before TestServer's default handler on every request. Await inside it
 * to delay the request; answer `res` and resolve `true` to skip the default
 * handler entirely.
 */
export type RequestInterceptor = (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;

export class TestServer {
	private server: import("http").Server | null = null;
	private port: number | null = null;
	public baseUrl: string = "";

	constructor(
		private options: {
			baseLatencyMs?: number;
			jitterMs?: number;
			failRate?: number;
			timeoutRate?: number;
			statusCodes?: number[];
			intercept?: RequestInterceptor;
		} = {},
	) {}

	async start(): Promise<number> {
		const http = await import("node:http");

		return new Promise((resolve) => {
			this.server = http.createServer(async (req, res) => {
				const handled: Promise<boolean> = this.options.intercept?.(req, res) ?? Promise.resolve(false);
				if (await handled) return;

				const latency = (this.options.baseLatencyMs ?? 10) + Math.random() * (this.options.jitterMs ?? 5);

				await new Promise((r) => setTimeout(r, latency));

				// Simulate timeouts
				if (Math.random() < (this.options.timeoutRate ?? 0)) {
					await new Promise(() => {}); // hang forever
					return;
				}

				// Simulate failures
				if (Math.random() < (this.options.failRate ?? 0)) {
					res.statusCode =
						this.options.statusCodes?.[Math.floor(Math.random() * this.options.statusCodes.length)] ?? 500;
					res.end("Simulated failure");
					return;
				}

				res.statusCode = 200;
				res.setHeader("Content-Type", "application/json");
				res.end(JSON.stringify({ success: true, timestamp: Date.now() }));
			});

			this.server.listen(0, "127.0.0.1", () => {
				const address = this.server!.address() as import("net").AddressInfo;
				this.port = address.port;
				this.baseUrl = `http://127.0.0.1:${this.port}`;
				resolve(this.port!);
			});
		});
	}

	stop(): Promise<void> {
		return new Promise((resolve) => {
			if (this.server) {
				this.server.close(() => resolve());
			} else {
				resolve();
			}
		});
	}
}

export function calculatePercentile(sorted: number[], percentile: number): number {
	if (sorted.length === 0) return 0;
	const index = Math.ceil((percentile / 100) * sorted.length) - 1;
	return sorted[Math.max(0, index)];
}

export async function runBenchmark(client: HttpClient, options: BenchmarkOptions): Promise<BenchmarkResult> {
	const latencies: number[] = [];
	const errors: Record<string, number> = {};
	let successful = 0;
	let failed = 0;

	const totalRequests = options.totalRequests ?? 1000;
	const concurrency = options.concurrency ?? 10;

	// Warmup
	if (options.warmupRequests) {
		console.log(`Warming up with ${options.warmupRequests} requests...`);
		const warmupPromises: Promise<void>[] = [];
		for (let i = 0; i < options.warmupRequests; i++) {
			warmupPromises.push(
				client
					.get("/warmup")
					.toPromise()
					.then(() => {}),
			);
			if (warmupPromises.length >= concurrency) {
				await Promise.allSettled(warmupPromises);
				warmupPromises.length = 0;
			}
		}
		await Promise.allSettled(warmupPromises);
	}

	console.log(`Starting benchmark: ${options.name} (${totalRequests} requests, concurrency: ${concurrency})`);

	const startTime = performance.now();
	const promises: Promise<void>[] = [];

	for (let i = 0; i < totalRequests; i++) {
		const start = performance.now();
		const promise = client
			.get(`/benchmark/${i}`)
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

		// Control concurrency
		if (promises.length >= concurrency) {
			await Promise.allSettled(promises);
			promises.length = 0;
		}
	}

	await Promise.allSettled(promises);
	const endTime = performance.now();
	const durationMs = endTime - startTime;

	// Calculate statistics
	latencies.sort((a, b) => a - b);
	const avgLatencyMs = latencies.reduce((sum, val) => sum + val, 0) / latencies.length || 0;

	return {
		name: options.name,
		totalRequests,
		successfulRequests: successful,
		failedRequests: failed,
		avgLatencyMs,
		p50LatencyMs: calculatePercentile(latencies, 50),
		p95LatencyMs: calculatePercentile(latencies, 95),
		p99LatencyMs: calculatePercentile(latencies, 99),
		minLatencyMs: latencies[0] ?? 0,
		maxLatencyMs: latencies[latencies.length - 1] ?? 0,
		requestsPerSecond: totalRequests / (durationMs / 1000),
		durationMs,
		errors,
		timestamp: new Date().toISOString(),
	};
}

/**
 * Persists a full run's results to a timestamped JSON file so runs can be
 * compared over time instead of only ever existing as console output.
 */
export async function saveResults(results: BenchmarkResult[], dir = "results"): Promise<string> {
	const fs = await import("node:fs/promises");
	const path = await import("node:path");

	await fs.mkdir(dir, { recursive: true });
	const filename = path.join(dir, `run-${Date.now()}.json`);
	await fs.writeFile(filename, JSON.stringify(results, null, 2));
	return filename;
}

export function printResults(result: BenchmarkResult): void {
	console.log(`\n${"=".repeat(60)}`);
	console.log(`BENCHMARK: ${result.name}`);
	console.log("=".repeat(60));
	console.log(`Timestamp: ${result.timestamp}`);
	console.log(`Duration: ${(result.durationMs / 1000).toFixed(2)}s`);
	console.log("-".repeat(60));
	console.log(`Total Requests:     ${result.totalRequests}`);
	console.log(`Successful:         ${result.successfulRequests}`);
	console.log(`Failed:             ${result.failedRequests}`);
	console.log(`Success Rate:       ${((result.successfulRequests / result.totalRequests) * 100).toFixed(2)}%`);
	console.log("-".repeat(60));
	console.log(`Requests/sec:       ${result.requestsPerSecond.toFixed(2)}`);
	console.log("-".repeat(60));
	console.log("Latency (ms):");
	console.log(`  Average:          ${result.avgLatencyMs.toFixed(2)}`);
	console.log(`  Min:              ${result.minLatencyMs.toFixed(2)}`);
	console.log(`  Max:              ${result.maxLatencyMs.toFixed(2)}`);
	console.log(`  p50:              ${result.p50LatencyMs.toFixed(2)}`);
	console.log(`  p95:              ${result.p95LatencyMs.toFixed(2)}`);
	console.log(`  p99:              ${result.p99LatencyMs.toFixed(2)}`);
	console.log("-".repeat(60));

	if (Object.keys(result.errors).length > 0) {
		console.log("Errors:");
		for (const [error, count] of Object.entries(result.errors)) {
			console.log(`  ${error}: ${count}`);
		}
	}

	console.log(`${"=".repeat(60)}\n`);
}
