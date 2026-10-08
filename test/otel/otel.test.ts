import { propagation, SpanKind, SpanStatusCode } from "@opentelemetry/api";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { MeterProvider, MetricReader } from "@opentelemetry/sdk-metrics";
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HttpClient } from "../../src/core/client.ts";
import { instrumentTracing, otelMetricsSink } from "../../src/otel/index.ts";

type FakeFetch = (url: string, init: RequestInit) => Promise<Response>;

/** Replies with `statuses` in order (the last one repeats); `"throw"` rejects
 *  like a dropped connection. Records each call's headers. */
function scripted(statuses: Array<number | "throw">, seen: Headers[] = []): FakeFetch {
	let call = 0;
	return async (_url, init) => {
		seen.push(new Headers(init.headers));
		const next = statuses[Math.min(call++, statuses.length - 1)];
		if (next === "throw") throw new TypeError("fetch failed");
		return new Response(null, { status: next });
	};
}

function makeClient(fetch: FakeFetch) {
	return HttpClient.create({
		timeout: { attemptMs: 1_000 },
		retry: { maxRetries: 2, backoff: { baseDelayMs: 1, jitter: false } },
		fetch: fetch as typeof globalThis.fetch,
	});
}

let exporter: InMemorySpanExporter;
let provider: BasicTracerProvider;

beforeEach(() => {
	exporter = new InMemorySpanExporter();
	provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
});

afterEach(async () => {
	propagation.disable();
	await provider.shutdown();
});

const tracer = () => provider.getTracer("test");
const spans = () => exporter.getFinishedSpans();
const ticketSpan = () => spans().find((s) => s.kind === SpanKind.INTERNAL);
const attemptSpans = () => spans().filter((s) => s.kind === SpanKind.CLIENT);

describe("instrumentTracing", () => {
	it("records a ticket span with one child span per attempt", async () => {
		const client = makeClient(scripted([503, 200]));
		instrumentTracing(client, { tracer: tracer() });

		await client.get("https://api.example.com/users").toPromise();

		const parent = ticketSpan();
		expect(parent).toMatchObject({
			name: "vereda GET",
			attributes: {
				"http.request.method": "GET",
				"url.full": "https://api.example.com/users",
				"http.response.status_code": 200,
				"vereda.attempts": 2,
				"vereda.partition": "api.example.com",
			},
		});
		expect(parent?.status.code).toBe(SpanStatusCode.UNSET);
		expect(parent?.events.map((e) => e.name)).toEqual(["vereda.retry"]);

		const [first, retry] = attemptSpans();
		expect(first?.name).toBe("GET");
		expect(first?.parentSpanContext?.spanId).toBe(parent?.spanContext().spanId);
		expect(retry?.parentSpanContext?.spanId).toBe(parent?.spanContext().spanId);
		expect(first?.attributes).toMatchObject({ "http.response.status_code": 503, "error.type": "503" });
		expect(first?.attributes["http.request.resend_count"]).toBeUndefined();
		expect(retry?.attributes).toMatchObject({ "http.response.status_code": 200, "http.request.resend_count": 1 });
	});

	it("marks a failed ticket with the error kind", async () => {
		const client = makeClient(scripted([404]));
		instrumentTracing(client, { tracer: tracer() });

		await client.get("https://api.example.com/missing").toPromise();

		expect(ticketSpan()?.status.code).toBe(SpanStatusCode.ERROR);
		expect(ticketSpan()?.attributes["error.type"]).toBe("http");
		expect(attemptSpans()).toHaveLength(1);
	});

	it("names a thrown attempt error by type only", async () => {
		const client = makeClient(scripted(["throw"]));
		instrumentTracing(client, { tracer: tracer() });

		await client.get("https://api.example.com/flaky").toPromise();

		expect(attemptSpans()).toHaveLength(3);
		for (const span of attemptSpans()) {
			expect(span.attributes["error.type"]).toBe("TypeError");
			expect(span.status.code).toBe(SpanStatusCode.ERROR);
		}
		expect(ticketSpan()?.attributes["error.type"]).toBe("max_retries");
	});

	it("leaves a cancelled ticket's status unset", async () => {
		const hang: FakeFetch = (_url, init) =>
			new Promise((_, reject) => init.signal?.addEventListener("abort", () => reject(init.signal?.reason)));
		const client = makeClient(hang);
		instrumentTracing(client, { tracer: tracer() });

		const ticket = client.get("https://api.example.com/slow");
		await new Promise((r) => setTimeout(r, 10));
		ticket.cancel();
		await ticket.toPromise();
		await new Promise((r) => setTimeout(r, 10));

		expect(ticketSpan()?.attributes["vereda.cancelled"]).toBe(true);
		expect(ticketSpan()?.status.code).toBe(SpanStatusCode.UNSET);
	});

	it("injects traceparent for the attempt span", async () => {
		propagation.setGlobalPropagator(new W3CTraceContextPropagator());
		const seen: Headers[] = [];
		const client = makeClient(scripted([200], seen));
		instrumentTracing(client, { tracer: tracer() });

		await client.get("https://api.example.com/users").toPromise();

		const [attempt] = attemptSpans();
		const traceparent = seen[0]?.get("traceparent");
		expect(traceparent).toBe(`00-${attempt?.spanContext().traceId}-${attempt?.spanContext().spanId}-01`);
	});

	it("doesn't inject with propagate: false", async () => {
		propagation.setGlobalPropagator(new W3CTraceContextPropagator());
		const seen: Headers[] = [];
		const client = makeClient(scripted([200], seen));
		instrumentTracing(client, { tracer: tracer(), propagate: false });

		await client.get("https://api.example.com/users").toPromise();

		expect(seen[0]?.has("traceparent")).toBe(false);
	});

	it("keeps credentials and query values out of every span", async () => {
		const client = makeClient(scripted([503, 200]));
		instrumentTracing(client, { tracer: tracer() });

		await client.get("https://bob:hunter2@api.example.com/auth?token=s3cret").toPromise();

		const dump = JSON.stringify(spans().map((s) => [s.attributes, s.events]));
		expect(dump).not.toContain("hunter2");
		expect(dump).not.toContain("s3cret");
		expect(ticketSpan()?.attributes["url.full"]).toBe("https://[redacted]@api.example.com/auth?token=[redacted]");
	});

	it("keeps the query with redactQuery: false, but never credentials", async () => {
		const client = makeClient(scripted([200]));
		instrumentTracing(client, { tracer: tracer(), redactQuery: false });

		await client.get("https://bob:hunter2@api.example.com/search?q=shoes").toPromise();

		expect(attemptSpans()[0]?.attributes["url.full"]).toBe("https://[redacted]@api.example.com/search?q=shoes");
	});

	it("stops recording once the returned function is called", async () => {
		const client = makeClient(scripted([200]));
		const stop = instrumentTracing(client, { tracer: tracer() });
		stop();

		const result = await client.get("https://api.example.com/users").toPromise();

		expect(result.success).toBe(true);
		expect(spans()).toEqual([]);
	});
});

class TestReader extends MetricReader {
	protected async onShutdown(): Promise<void> {}
	protected async onForceFlush(): Promise<void> {}
}

describe("otelMetricsSink", () => {
	it("records counters, the duration histogram, and gauges", async () => {
		const reader = new TestReader();
		const meterProvider = new MeterProvider({ readers: [reader] });
		const client = HttpClient.create({
			timeout: { attemptMs: 1_000 },
			retry: { maxRetries: 1, backoff: { baseDelayMs: 1, jitter: false } },
			fetch: scripted([503, 200]) as typeof globalThis.fetch,
			metrics: otelMetricsSink(meterProvider.getMeter("test")),
		});

		await client.get("https://api.example.com/users").toPromise();

		const { resourceMetrics } = await reader.collect();
		const metrics = new Map(resourceMetrics.scopeMetrics.flatMap((s) => s.metrics).map((m) => [m.descriptor.name, m]));
		expect(metrics.get("vereda.requests")?.dataPoints[0]?.value).toBe(1);
		expect(metrics.get("vereda.retries")?.dataPoints[0]?.value).toBe(1);
		expect(metrics.get("vereda.duration_ms")?.descriptor.unit).toBe("ms");
		expect(metrics.get("vereda.in_flight")?.dataPoints[0]?.value).toBe(0);
		await meterProvider.shutdown();
	});
});
