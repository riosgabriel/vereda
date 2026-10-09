# Observability

Seeing what the client is doing: lifecycle events, metrics, and OpenTelemetry. Back to the [README](../../README.md).

## Lifecycle events

The client emits typed events across all requests, useful for metrics, logging, and alerting. Exactly one of `success`, `failure`, or `cancelled` fires per ticket:

```typescript
client.on("request",   ({ ticketId, url, method, partition }) => {});
client.on("retry",     ({ ticketId, url, partition, attempt, delayMs, error }) => {});
client.on("success",   ({ ticketId, url, partition, attempts, durationMs, queuedMs, statusCode }) => {});
client.on("failure",   ({ ticketId, url, partition, attempts, durationMs, queuedMs, error }) => {});
client.on("cancelled", ({ ticketId, url, partition, attempts, durationMs, queuedMs }) => {});
```

`retry`'s `attempt` is a zero-based retry index (`0` = the first retry, after the initial attempt). `off(event, listener)` removes a listener with the same signature as `on`. A listener (or `metrics` sink) that throws never affects the request: every other listener still runs, and the error is rethrown on a microtask, so it surfaces as an uncaught error: `process.on("uncaughtException")` on Node, the global `error` event on runtimes that have one.

`queuedMs` is the total time this ticket spent waiting for a bulkhead/global-semaphore permit, summed across every attempt — it's `0` when a request never had to wait (the default global cap is 50 concurrent, so most single-service consumers never hit it). A consistently nonzero `queuedMs` relative to `durationMs` means you're throttled by `concurrency`/a partition's `concurrency`, not by downstream latency; see [Wiring a metrics sink](../operations.md#wiring-a-metrics-sink) for the companion `vereda.queue_depth` / `vereda.global_queue_depth` gauges.

If the circuit breaker is enabled, a partition also fires `circuitOpen`/`circuitClose` independently of any single ticket:

```typescript
client.on("circuitOpen",  ({ partition }) => {});
client.on("circuitClose", ({ partition }) => {});
```

## Metrics

Pass a `metrics` sink and the client reports counters, histograms and gauges as requests run. A sink is three methods, so it's a thin adapter over OpenTelemetry, StatsD, Prometheus or whatever your service already uses:

```typescript
import { HttpClient, type MetricsSink } from "@vereda/http";

const metrics: MetricsSink = {
  counter: (name, value, tags) => console.log("counter", name, value, tags),
  histogram: (name, value, tags) => console.log("histogram", name, value, tags),
  gauge: (name, value, tags) => console.log("gauge", name, value, tags),
};

const client = HttpClient.create({ timeout: { attemptMs: 5_000 }, metrics });
```

| Metric | Type | Tags |
| --- | --- | --- |
| `vereda.requests` | counter | `partition`, `method` |
| `vereda.retries` | counter | `partition`, `kind` (what triggered the retry) |
| `vereda.duration_ms` | histogram | `partition`, `kind` (`success`, `cancelled`, or the error `kind`) |
| `vereda.circuit_open` | counter | `partition` |
| `vereda.queue_depth` | gauge | `partition` |
| `vereda.in_flight`, `vereda.global_queue_depth` | gauge | none |

Because everything that concerns a single dependency is tagged with `partition` (its host, unless you set one), one struggling upstream gets its own line on a graph instead of being averaged into all the others. For OpenTelemetry, use the ready-made sink below. The [operations guide](../operations.md#wiring-a-metrics-sink) covers each metric in detail and how to read the queue-depth gauges.

## OpenTelemetry

`@vereda/http/otel` connects a client to OpenTelemetry. It needs `@opentelemetry/api` (an optional peer dependency; only this entry point imports it) and an SDK you set up as usual:

```typescript
import { metrics, trace } from "@opentelemetry/api";
import { HttpClient } from "@vereda/http";
import { instrumentTracing, otelMetricsSink } from "@vereda/http/otel";

const client = HttpClient.create({
  timeout: { attemptMs: 5_000 },
  metrics: otelMetricsSink(metrics.getMeter("checkout")),
});

// After your own client.use() calls, so the attempt span sits closest to fetch.
const stop = instrumentTracing(client, { tracer: trace.getTracer("checkout") });
```

- **Traces:** one span per ticket covering queueing, every attempt and backoff, with a child `CLIENT` span per attempt. Attributes follow the HTTP semantic conventions (`http.request.method`, `url.full`, `http.response.status_code`, `http.request.resend_count` on retries, `error.type`), and each retry adds a `vereda.retry` event to the ticket span. A cancelled ticket keeps an unset status.
- **Propagation:** each attempt's `traceparent` (through your registered propagator) is injected into the request headers, so downstream services join the trace. Turn it off with `propagate: false`.
- **Redaction:** `url.full` never contains credentials, and query values are replaced with `[redacted]` unless you pass `redactQuery: false`. Attempt errors are recorded by type only, since an error message can contain a URL.
- **Metrics:** `otelMetricsSink` records the [metrics above](#metrics) as OpenTelemetry counters, a histogram (unit `ms`) and observable gauges.

`stop()` ends any open ticket spans and stops recording. The attempt middleware stays registered, since middleware can't be removed, but it no longer records anything.
