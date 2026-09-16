import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HttpClient } from "../../src/core/client.js";
import { METRICS, type MetricsSink, type MetricTags } from "../../src/core/metrics.js";

interface TestServer {
	url: string;
	close: () => Promise<void>;
	setHandler: (fn: (req: IncomingMessage, res: ServerResponse) => void) => void;
}

function createTestServer(): Promise<TestServer> {
	return new Promise((resolve) => {
		let handler: (req: IncomingMessage, res: ServerResponse) => void = (_req, res) => {
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ ok: true }));
		};
		const server = createServer((req, res) => handler(req, res));
		server.listen(0, "127.0.0.1", () => {
			const addr = server.address() as { port: number };
			resolve({
				url: `http://127.0.0.1:${addr.port}`,
				close: () => new Promise((r) => server.close(() => r())),
				setHandler: (fn) => {
					handler = fn;
				},
			});
		});
	});
}

function createFakeSink(): MetricsSink & {
	counters: { name: string; value: number; tags?: MetricTags }[];
	histograms: { name: string; value: number; tags?: MetricTags }[];
	gauges: { name: string; value: number; tags?: MetricTags }[];
} {
	const counters: { name: string; value: number; tags?: MetricTags }[] = [];
	const histograms: { name: string; value: number; tags?: MetricTags }[] = [];
	const gauges: { name: string; value: number; tags?: MetricTags }[] = [];
	return {
		counters,
		histograms,
		gauges,
		counter: (name, value, tags) => counters.push({ name, value, tags }),
		histogram: (name, value, tags) => histograms.push({ name, value, tags }),
		gauge: (name, value, tags) => gauges.push({ name, value, tags }),
	};
}

describe("Metrics sink (6.2)", () => {
	let server: TestServer;

	beforeAll(async () => {
		server = await createTestServer();
	});

	afterAll(async () => {
		await server.close();
	});

	it("records counter for one successful request", async () => {
		const sink = createFakeSink();
		const client = HttpClient.create({ timeout: { attemptMs: 5_000 }, metrics: sink });

		server.setHandler((_req, res) => {
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end("{}");
		});

		await client.get(`${server.url}/ok`).toPromise();

		const reqCounters = sink.counters.filter((c) => c.name === METRICS.REQUESTS);
		expect(reqCounters.length).toBeGreaterThanOrEqual(1);
		const last = reqCounters[reqCounters.length - 1];
		expect(last.value).toBe(1);
		expect(last.tags?.method).toBe("GET");
		expect(last.tags?.partition).toBeTruthy();

		const durations = sink.histograms.filter((h) => h.name === METRICS.DURATION);
		expect(durations).toHaveLength(1);
		expect(durations[0].value).toBeGreaterThanOrEqual(0);
		expect(durations[0].tags?.kind).toBe("success");

		const retries = sink.counters.filter((c) => c.name === METRICS.RETRIES);
		expect(retries).toHaveLength(0);

		await client.close();
	});

	it("records retries and duration for exhausted retry", async () => {
		const sink = createFakeSink();
		const client = HttpClient.create({
			timeout: { attemptMs: 5_000 },
			metrics: sink,
			retry: {
				maxRetries: 2,
				retryOnStatus: [503],
				backoff: { baseDelayMs: 10, jitter: false },
			},
		});

		server.setHandler((_req, res) => {
			res.writeHead(503, { "Content-Type": "application/json" });
			res.end("{}");
		});

		await client.get(`${server.url}/fail`).toPromise();

		const reqCounters = sink.counters.filter((c) => c.name === METRICS.REQUESTS);
		expect(reqCounters.length).toBeGreaterThanOrEqual(1);

		const retryCounters = sink.counters.filter((c) => c.name === METRICS.RETRIES);
		expect(retryCounters).toHaveLength(2);
		for (const r of retryCounters) {
			expect(r.value).toBe(1);
			expect(r.tags?.kind).toBe("retryable_status");
		}

		const durations = sink.histograms.filter((h) => h.name === METRICS.DURATION);
		expect(durations).toHaveLength(1);
		expect(durations[0].value).toBeGreaterThanOrEqual(0);
		expect(durations[0].tags?.kind).toBe("max_retries");

		await client.close();
	});

	it("records gauge for in-flight count", async () => {
		const sink = createFakeSink();
		const client = HttpClient.create({ timeout: { attemptMs: 5_000 }, metrics: sink });

		server.setHandler((_req, res) => {
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end("{}");
		});

		await client.get(`${server.url}/ok`).toPromise();

		const gauges = sink.gauges.filter((g) => g.name === METRICS.IN_FLIGHT);
		expect(gauges.length).toBeGreaterThanOrEqual(1);
		// At success emit time the ticket hasn't been cleaned up yet, so size is 1
		const lastGauge = gauges[gauges.length - 1];
		expect(lastGauge.value).toBeGreaterThanOrEqual(1);

		await client.close();
	});

	it("records nonzero global_queue_depth while the global concurrency cap has a sustained backlog", async () => {
		// Gauges are pushed only from emit()'s request-start and terminal-event
		// hooks (client.ts emitQueueDepthGauges), not from the semaphore's own
		// enqueue/dequeue — so a single momentarily-blocked request is invisible
		// to this gauge (the request-start emit fires before it ever tries to
		// acquire; the terminal emit fires after release() has already drained
		// it). A *sustained* backlog (more waiters than one release can drain)
		// is required to land a nonzero reading at one of those two hooks — the
		// realistic case for a dashboard/alert on this metric. Per-request
		// visibility for a single blocked request is `queuedMs` on the
		// lifecycle events instead (see the saturation test in
		// lifecycle-events.test.ts), which has no such blind spot.
		const sink = createFakeSink();
		const client = HttpClient.create({
			timeout: { attemptMs: 5_000 },
			metrics: sink,
			concurrency: 1, // global cap: only one request in flight at a time
			retry: { maxRetries: 0 },
		});

		server.setHandler((_req, res) => {
			setTimeout(() => {
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end("{}");
			}, 60);
		});

		await Promise.all([
			client.get(`${server.url}/a`).toPromise(),
			client.get(`${server.url}/b`).toPromise(),
			client.get(`${server.url}/c`).toPromise(),
		]);

		const globalDepthGauges = sink.gauges.filter((g) => g.name === METRICS.GLOBAL_QUEUE_DEPTH);
		expect(globalDepthGauges.length).toBeGreaterThanOrEqual(1);
		expect(Math.max(...globalDepthGauges.map((g) => g.value))).toBeGreaterThanOrEqual(1);
		// Backlog must drain back to 0 once all three requests settle.
		expect(globalDepthGauges[globalDepthGauges.length - 1].value).toBe(0);

		await client.close();
	});

	it("does not record metrics when no sink is configured", async () => {
		const client = HttpClient.create({ timeout: { attemptMs: 5_000 } });

		server.setHandler((_req, res) => {
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end("{}");
		});

		const result = await client.get(`${server.url}/ok`).toPromise();
		expect(result.success).toBe(true);

		await client.close();
	});
});
