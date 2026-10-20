# Observability

Seeing what the client is doing: lifecycle events, metrics, and OpenTelemetry. Back to the [README](../../README.md).

## Lifecycle events

The client emits typed events across all requests. Use them for logging, alerting or your own metrics.

Exactly one of `success`, `failure` or `cancelled` fires per ticket.

```typescript
client.on("request",   ({ ticketId, url, method, partition }) => {});
client.on("retry",     ({ ticketId, url, partition, attempt, delayMs, error }) => {});
client.on("success",   ({ ticketId, url, partition, attempts, durationMs, queuedMs, statusCode }) => {});
client.on("failure",   ({ ticketId, url, partition, attempts, durationMs, queuedMs, error }) => {});
client.on("cancelled", ({ ticketId, url, partition, attempts, durationMs, queuedMs }) => {});
```

In `retry`, `attempt` is a zero-based retry index: `0` is the first retry, after the initial attempt.

**Example** (removing a listener)

```typescript
const onFailure = ({ url, error }: { url: string; error: { kind: string } }) =>
  console.error("request failed", url, error.kind);

client.on("failure", onFailure);
client.off("failure", onFailure); // same signature as on()
```

### A listener that throws

A listener, or a `metrics` sink, that throws never affects the request. Every other listener still runs.

The error is rethrown on a microtask, so it surfaces as an uncaught error:

- On Node: `process.on("uncaughtException")`.
- On runtimes that have one: the global `error` event.

### Time spent waiting: `queuedMs`

`queuedMs` is the total time a ticket waited, summed across every attempt. It counts waits for a bulkhead permit, a global-semaphore permit or a [rate-limit](resilience.md#rate-limiting) token.

It's `0` when a request never had to wait. The default global cap is 50 concurrent requests, so most single-service consumers never hit it.

**Example** (spotting throttling)

```typescript
client.on("success", ({ partition, durationMs, queuedMs }) => {
  if (queuedMs > durationMs / 2) console.warn("mostly queued", partition, queuedMs);
});
```

A `queuedMs` that stays high relative to `durationMs` means a `concurrency` limit is throttling you, not downstream latency. For the matching gauges, `vereda.queue_depth` and `vereda.global_queue_depth`, see [Wiring a metrics sink](../operations.md#wiring-a-metrics-sink).

### Retry budget and circuit breaker events

With a [retry budget](resilience.md#retry-budget) configured, `retryBudgetExhausted` fires when the budget refuses a retry. It fires right before that ticket's `failure` event.

```typescript
client.on("retryBudgetExhausted", ({ ticketId, url, partition }) => {});
```

With the circuit breaker enabled, a partition also fires `circuitOpen` and `circuitClose`. These don't belong to any single ticket.

```typescript
client.on("circuitOpen",  ({ partition }) => {});
client.on("circuitClose", ({ partition }) => {});
```

## Metrics

Pass a `metrics` sink, and the client reports counters, histograms and gauges as requests run.

A sink is three methods. That makes it a thin adapter over OpenTelemetry, StatsD, Prometheus or whatever your service already uses.

**Example** (a sink that logs every data point)

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
| `vereda.retry_budget_exhausted` | counter | `partition` |
| `vereda.queue_depth` | gauge | `partition` |
| `vereda.in_flight`, `vereda.global_queue_depth` | gauge | none |

Everything that concerns a single dependency is tagged with `partition`: its host, unless you set one. So one struggling upstream gets its own line on a graph instead of being averaged into all the others.

For OpenTelemetry, use the [ready-made sink](#opentelemetry). The [operations guide](../operations.md#wiring-a-metrics-sink) covers each metric in detail, including how to read the queue-depth gauges.

## OpenTelemetry

`@vereda/http/otel` connects a client to OpenTelemetry.

It needs `@opentelemetry/api`, an optional peer dependency that only this entry point imports. Set up the SDK as usual.

**Example** (metrics and traces)

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

| | What you get |
| --- | --- |
| **Traces** | One span per ticket, covering queueing, every attempt and backoff, with a child `CLIENT` span per attempt |
| **Propagation** | Each attempt's `traceparent` is injected into the request headers through your registered propagator, so downstream services join the trace |
| **Redaction** | `url.full` never contains credentials, and query values become `[redacted]` |
| **Metrics** | `otelMetricsSink` records the [metrics above](#metrics) as counters, a histogram (unit `ms`) and observable gauges |

### Span details

- Attributes follow the HTTP semantic conventions: `http.request.method`, `url.full`, `http.response.status_code`, `http.request.resend_count` on retries, and `error.type`.
- Each retry adds a `vereda.retry` event to the ticket span.
- A cancelled ticket keeps an unset status.
- Attempt errors are recorded by type only, since an error message can contain a URL.

### Options

- `propagate: false` turns off header injection.
- `redactQuery: false` keeps query values in `url.full`. Credentials are still removed.

### Stopping

`stop()` ends any open ticket spans and stops recording.

The attempt middleware stays registered, since middleware can't be removed, but it no longer records anything.
