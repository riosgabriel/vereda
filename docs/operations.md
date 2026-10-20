# Operations guide

This guide covers running Vereda in production: how to size its limits, how to read its runtime state, and how to shut it down cleanly.

For the API itself, see the [README](../README.md), the [feature guides](guide/resilience.md) and the [API reference](https://vereda.dev/api/).

## Sizing concurrency and queues

Vereda has two concurrency limits, and they work independently.

| Limit | Option | Default | Applies to |
| --- | --- | --- | --- |
| Global | `concurrency` | 50 | Every attempt, across all hosts |
| Per partition | `partitions[name].concurrency` | 5 | Retries to one host |

Each limit has a wait queue behind it, sized by `maxQueueSize` (default 100). When a queue is full, the request resolves with `QueueFullError`. For the global queue, the error's `scope` is `"global"`.

**Example** (limits for one host)

```typescript
const client = HttpClient.create({
  timeout: { attemptMs: 5_000 },
  concurrency: 50, // the whole process
  partitions: {
    "api.example.com": { concurrency: 5, maxQueueSize: 20 },
  },
});
```

### Why first attempts skip the partition limit

The partition limit applies only to retries. The first attempt of every request skips it.

This is deliberate: a struggling host should slow down its own retry traffic, not new work. See [Design philosophy](../README.md#design-philosophy) in the README.

The global limit does apply to every attempt. So a host that fails *slowly* can hold global permits and, under enough load, delay or reject requests to healthy hosts. Keep `attemptMs` short for such hosts, or turn on [`limitFirstAttempts`](#fragile-hosts-limitfirstattempts).

### Picking the numbers

- **Partition concurrency.** Close to what the host can really serve at once: its connection pool, rate limit or known capacity. Too high, and a struggling host's retries pile back onto it. Too low, and good retries wait behind slow ones.
- **Queue size.** How much retry backlog you accept before you'd rather fail fast. A small queue (10 to 50) shows backpressure quickly. A large one absorbs bursts, but its retries may be stale by the time they run.
- **Global concurrency.** A ceiling for the whole process. Base it on your own outbound connection limits or memory budget, not on any one host's capacity.

### Many hosts: `defaultPartition`

Instead of listing every host, set `defaultPartition`. It applies to every partition not named in `partitions` and takes the same fields: concurrency, queue size, retry, timeout, circuit breaker, retry budget, rate limit and `limitFirstAttempts`.

A listed partition doesn't inherit from it. Its entry is the whole config for that host, on top of the client-level settings.

**Example**

```typescript
const client = HttpClient.create({
  timeout: { attemptMs: 5_000 },
  defaultPartition: { concurrency: 5, maxQueueSize: 50 },
  partitions: {
    // replaces defaultPartition for this host: nothing is merged
    "payments.example.com": { concurrency: 2, maxQueueSize: 10 },
  },
});
```

### Capping retry volume: retry budget

Bulkheads cap how many retries run *at once*, not how many run in total. To cap a failing host's retry volume, set a [retry budget](guide/resilience.md#retry-budget).

```typescript
retryBudget: { ratio: 0.1, windowMs: 10_000 }
```

- `ratio` is the extra load you accept during an outage: `0.1` means 10%.
- Keep `windowMs` well above your backoff delays, so retries count against the same window as the traffic that paid for them.
- For hosts that see only a few requests per second, lower `minRetriesPerSec`. Otherwise the floor admits more retries than the ratio would.

Watch `vereda.retry_budget_exhausted`. A steady rate of refusals means the host is degraded, not just failing now and then.

### Hosts with a quota: rate limit

For a host with a requests-per-second quota, set a [rate limit](guide/resilience.md#rate-limiting) a little under the quota, so a `429` stays rare.

```typescript
rateLimit: { tokensPerSec: 90, maxWaitMs: 2_000 } // the host allows 100/s
```

Set `maxWaitMs` below `timeout.totalMs` if you'd rather fail fast with `RateLimitedError` than spend most of the deadline waiting for a token.

The limit is per process. With N replicas calling the same host, divide the quota by N.

### Fragile hosts: `limitFirstAttempts`

Set `limitFirstAttempts: true` on a partition only if its host is so fragile that even first attempts need throttling. It's off by default because it changes latency for fresh traffic, not just retries.

When a partition fills up, [`client.partitions()`](#reading-partitions) shows it before it becomes an incident.

## `attemptMs` vs. `totalMs`

Vereda has two timeouts, and they measure different things.

| | Bounds | Required | On expiry |
| --- | --- | --- | --- |
| `attemptMs` | One attempt: the first, or any retry | Yes, on the client (`Infinity` opts out) | `TimeoutError`, retried like any transient failure |
| `totalMs` | The whole call, retries included | No, off by default | `DeadlineExceededError`, and no more retries |

They compose. A request can time out on single attempts several times and still be retried, until `totalMs` ends it.

**Example**

```typescript
const client = HttpClient.create({
  timeout: {
    attemptMs: 2_000, // about your p99 for a healthy call
    totalMs: 10_000, // the longest the caller should wait
  },
});
```

A good starting point: set `attemptMs` to your p99 latency for a healthy call, and `totalMs` to the longest you'll make the caller wait end to end. Count in `maxRetries` × backoff.

### What `totalMs` covers

The deadline starts when you call `request()`, `get()` or any other method. It covers everything after that: time in a queue, backoff sleeps and the attempts themselves.

If a retry's backoff delay would reach the deadline, Vereda doesn't sleep on it. The ticket fails at once with `DeadlineExceededError`, with the last attempt's error as its `cause`.

Only the delay is compared, not the delay plus `attemptMs`. `attemptMs` is an upper bound, and a retry that answers quickly can still fit.

### Reading the body later

Both deadlines also bound reading a body that Vereda hands back unread. That's a success with neither `parse` nor `responseType`, or an `HttpError`'s `.response`.

The read has to finish within the remaining `attemptMs` or the ticket's `totalMs`, whichever ends first, counted from that attempt's start. A parsed body already gets this bound, because it's read inside the attempt. Without it, a server that sends headers and then stalls the body would let `raw.json()` or `error.response.text()` hang past both deadlines.

When the bound fires, the read rejects with Vereda's own error:

- `TimeoutError` when `attemptMs` fired first, or was the only bound.
- `DeadlineExceededError` when `totalMs` fired first.

Both are ordinary Vereda errors, so `instanceof` and `.kind` work as usual.

To stream a body or read it later (long downloads, deferred processing), set `timeout: { attemptMs: Infinity }` on that request with no `totalMs`. Or pass your own `AbortSignal` as `options.signal`.

## Reading `partitions()`

```typescript
const snapshots = client.partitions();
// [{ partition: "api.example.com", running: 2, queued: 5,
//    concurrency: 5, maxQueueSize: 100, tokens: 3 }, ...]
```

There's one entry per partition that has seen a request.

- `running` and `queued` count retry traffic only, at that moment. First attempts never appear here, by design.
- `queued` near `maxQueueSize` means the partition is saturated. New retries to it will start failing with `QueueFullError`.
- `tokens` appears only for a partition with a rate limit: how many tokens are free right now. `0` while requests stall means the rate limit is holding them back, not concurrency.
- `name` holds the same value as `partition`. It's deprecated and goes away in 2.0.

Poll it on an interval and feed it to your metrics, or check it when a host's requests seem stuck.

## Reading `circuits()`

```typescript
const circuits = client.circuits();
// [{ partition: "api.example.com", state: "open", failures: 5,
//    openedAt: 1767225600000, nextAttemptAt: 1767225630000 }, ...]
```

There's one entry per partition with an enabled circuit breaker that has seen a request. With no breaker configured, it returns `[]`.

Use it together with the `circuitOpen` and `circuitClose` events. The events tell you when a circuit changes. The snapshot tells you where every circuit is right now, which suits a health endpoint.

An `open` entry whose `nextAttemptAt` is in the past hasn't had a request since its reset timeout ran out. The next request becomes the half-open trial.

## Wiring a metrics sink

Implement `MetricsSink` and pass it as `metrics`. Its three methods, `counter`, `histogram` and `gauge`, must be synchronous and must not block.

**Example** (a sink that logs every data point)

```typescript
import { HttpClient, type MetricsSink } from "@vereda/http";

const sink: MetricsSink = {
  counter: (name, value, tags) => console.log("counter", name, value, tags),
  histogram: (name, value, tags) => console.log("histogram", name, value, tags),
  gauge: (name, value, tags) => console.log("gauge", name, value, tags),
};

const client = HttpClient.create({ timeout: { attemptMs: 5_000 }, metrics: sink });
```

Vereda emits these series. Match on the exported `METRICS` constants rather than the string names.

| Series | Type | Tags | Meaning |
| --- | --- | --- | --- |
| `METRICS.REQUESTS`<br>`vereda.requests` | counter | `partition`, `method` | One per request initiated |
| `METRICS.RETRIES`<br>`vereda.retries` | counter | `partition`, `kind` | One per retry attempt, tagged by the error `kind` that triggered it |
| `METRICS.DURATION`<br>`vereda.duration_ms` | histogram | `partition`, `kind` | Total ticket duration at settlement |
| `METRICS.QUEUE_DEPTH`<br>`vereda.queue_depth` | gauge | `partition` | Current per-partition queue size |
| `METRICS.GLOBAL_QUEUE_DEPTH`<br>`vereda.global_queue_depth` | gauge | — | Callers currently waiting for a permit under the global concurrency cap |
| `METRICS.IN_FLIGHT`<br>`vereda.in_flight` | gauge | — | Tickets started but not yet finished, across all partitions |
| `METRICS.CIRCUIT_OPEN`<br>`vereda.circuit_open` | counter | `partition` | One per circuit breaker trip to open |
| `METRICS.RETRY_BUDGET_EXHAUSTED`<br>`vereda.retry_budget_exhausted` | counter | `partition` | One per retry the partition's retry budget refused |

- **`DURATION` tags.** `partition` is absent only when the URL couldn't be resolved. `kind` is `success`, `cancelled` or the error `kind`.
- **`QUEUE_DEPTH`** counts retries only, like `partitions()`. A partition shows queued first attempts only if `limitFirstAttempts` is on for it.
- **`GLOBAL_QUEUE_DEPTH`** is the signal that the global `concurrency` is throttling you, not downstream latency.
- **`IN_FLIGHT`** is reported when a ticket starts and when it finishes, so it returns to `0` when the client is idle.
- **`CIRCUIT_OPEN` and `RETRY_BUDGET_EXHAUSTED`** come from opt-in features. They stay silent unless `circuitBreaker.enabled` or `retryBudget` is set.

For OpenTelemetry, use `otelMetricsSink` from `@vereda/http/otel`. Counters and the duration histogram map directly, and gauges become observable gauges that report the latest value per tag set. See [OpenTelemetry](guide/observability.md#opentelemetry) in the Observability guide, which also covers tracing.

For logging and alerting, use [lifecycle events](guide/observability.md#lifecycle-events) instead: `request`, `retry`, `success`, `failure`, `cancelled`, `retryBudgetExhausted`, `circuitOpen` and `circuitClose`.

### Queue gauges are sampled

The two queue-depth gauges aren't pushed when a queue changes. Vereda reads them when a request starts and when a ticket finishes.

That reliably shows a *sustained* backlog: an alert on "depth > N for 5 minutes" works as expected. But a request that queues briefly between two readings can go unseen.

For per-request visibility, use `queuedMs` on the lifecycle events. It's measured when the permit is acquired, not sampled.

## Shutdown sequence

There are two ways to close a client.

| Call | What happens | Use it for |
| --- | --- | --- |
| `close()` | Cancels every in-flight ticket at once | A hard, fast exit |
| `close({ drain: true, timeoutMs })` | Waits for in-flight tickets up to `timeoutMs`, then cancels the rest | Graceful shutdown, so requests about to succeed can finish |

**Example**

```typescript
process.on("SIGTERM", async () => {
  await client.close({ drain: true, timeoutMs: 30_000 });
});
```

Either way, new requests after `close()` fail with `ConfigurationError("client closed")`.

`timeoutMs` must be a finite number from 1 to 2,147,483,647 ms, the longest delay a timer honours (about 24.8 days). Otherwise `close({ drain: true })` rejects with a `ConfigurationError` and the client stays open.

Call `close()` once per client before the process exits, in the shutdown handler you already use. Extra calls are harmless: a `close()` during a drain returns the same promise, which resolves when the shutdown finishes.

You don't need `close()` for the process to exit. Every internal timer (backoff sleeps, both deadlines) is `unref()`ed when it's created, so a Vereda client never keeps the Node event loop alive on its own. `close()` is about settling in-flight tickets cleanly.

## Redaction

`redactQuery` is on by default. It hides secrets in the URLs that Vereda shows you:

- Query *values* become `[redacted]` and keys stay: `?token=abc123` becomes `?token=[redacted]`.
- Credentials in the URL become `[redacted]@`: `https://user:pass@host` becomes `https://[redacted]@host`.

That covers API keys, session tokens and personal data passed in the URL. It applies to every URL in a lifecycle event, in a call to your `logger`, and in an error: the `message` and `url` of `TimeoutError` and `DeadlineExceededError`, and so `MaxRetriesExceededError.message` too.

Vereda never logs or emits request or response *headers*, whatever this setting says. An `Authorization` header can't leak into logs through the library.

### What it doesn't cover

Redaction only touches what Vereda itself surfaces. Redact the rest yourself:

- Your own middleware that logs `ctx` or `options`.
- The raw `Response`, including `HttpError.response.url`.
- Request bodies with sensitive data.

`redactUrl` is exported from `@vereda/http` for that.

The bundled `requestLogger()` middleware redacts the same way by default. Middleware can't see the client's config, so to turn it off there too, pass `requestLogger({ redactQuery: false })`.

Set `redactQuery: false` only in trusted environments, such as local development against a mock server.
