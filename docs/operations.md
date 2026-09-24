# Operations guide

This guide is for running Vereda in production: sizing its knobs, reading its runtime state, and shutting it down cleanly. For the API itself, see the [README](../README.md) and the [API reference](https://riosgabriel.github.io/vereda/).

## Sizing concurrency and queues

Vereda has two independent concurrency limits:

- **Global (`concurrency`, default `50`)** — a semaphore shared across every partition. It bounds total in-flight *retry* executions against your process, regardless of how many hosts you talk to.
- **Per-partition (`partitions[name].concurrency`, default `5`)** — how many retries may run at once for a single partition (host). `partitions[name].maxQueueSize` (default `100`) bounds how many more retries may wait behind that limit before a request is rejected with `QueueFullError`.

Both limits apply **only to retries**. The first attempt for every request fires immediately, outside every bulkhead — this is deliberate (see [Design philosophy](../README.md#design-philosophy) in the README): a struggling downstream should throttle its own retry traffic, not new work.

Ballpark sizing:

- Set per-partition `concurrency` close to what the downstream service can actually sustain concurrently (its own connection pool, rate limit, or known capacity). Too high and a struggling host's retries pile pressure back onto it; too low and legitimate retry traffic queues behind slow ones unnecessarily.
- Set `maxQueueSize` based on how much retry backlog is acceptable before you'd rather fail fast. A small queue (`10`–`50`) surfaces backpressure quickly; a large one absorbs bursts but risks stale-by-the-time-they-run retries.
- Set the global `concurrency` as a process-wide ceiling — the sum of what you're willing to have in flight across all partitions at once, informed by your own outbound connection limits or memory budget, not by any single downstream's capacity.
- Turn on `partition.limitFirstAttempts: true` only if a partition's downstream is fragile enough that *even first attempts* need throttling (R6). Off by default because it changes latency for fresh traffic, not just retries.

When a partition fills up, `client.partitions()` (below) is how you observe it before it becomes an incident.

## `attemptMs` vs. `totalMs`

Two different timeouts, both optional and both `undefined` (disabled) by default:

- **`timeout.attemptMs`** — a per-attempt deadline. Each individual attempt (the first one and every retry) is aborted if it runs longer than this, and the result folds into the normal retry loop as a `TimeoutError` (retried like any other transient failure).
- **`timeout.totalMs`** — a whole-ticket deadline, starting when `request()`/`get()`/etc. is called. It covers time spent queued, sleeping in backoff, and executing — everywhere. On expiry the ticket resolves with `DeadlineExceededError`, a terminal error; no further retries happen even if attempts remain.

Use `attemptMs` to bound a single slow call (protects you from a hung connection). Use `totalMs` to bound how long a caller is willing to wait for an eventual answer at all, independent of how many retries that took. They compose: a request can time out on an individual attempt several times and still be retried, right up until `totalMs` cuts it off entirely.

A reasonable starting point: set `attemptMs` to your p99 expected latency for a healthy call, and `totalMs` to the longest you're willing to make the caller wait end-to-end (factoring in `maxRetries` × backoff).

## Reading `partitions()`

```typescript
const snapshots = client.partitions();
// [{ name: "api.example.com", running: 2, queued: 5, concurrency: 5, maxQueueSize: 100 }, ...]
```

One entry per partition that has handled at least one retry. `running` and `queued` are point-in-time counts of retry traffic only (first attempts never appear here, by design). Poll this on an interval and feed it into your metrics sink's gauges, or check it directly when debugging why a specific host's requests seem stuck — `queued` near `maxQueueSize` means that partition is saturated and new retries for it will start failing with `QueueFullError`.

## Wiring a metrics sink

Implement `MetricsSink` (`counter`, `histogram`, `gauge` — all synchronous, non-blocking) and pass it as `metrics` in `ClientConfig`. Vereda emits the series in `METRICS` (`src/core/metrics.ts`), exported so you don't have to hardcode the string names:

| Series | Type | Tags | Meaning |
| --- | --- | --- | --- |
| `METRICS.REQUESTS` (`vereda.requests`) | counter | `partition`, `method` | One per request initiated |
| `METRICS.RETRIES` (`vereda.retries`) | counter | `partition`, `kind` | One per retry attempt, tagged by the error `kind` that triggered it |
| `METRICS.DURATION` (`vereda.duration_ms`) | histogram | `partition`, `kind`, `status` | Total ticket duration at settlement |
| `METRICS.QUEUE_DEPTH` (`vereda.queue_depth`) | gauge | `partition` | Current per-partition queue size — same retries-only caveat as `partitions()` above: a partition only shows queued first attempts if `limitFirstAttempts` is enabled for it |
| `METRICS.GLOBAL_QUEUE_DEPTH` (`vereda.global_queue_depth`) | gauge | — | Callers currently waiting for a permit under the global concurrency cap (D1) — the signal that you're throttled by `concurrency`/`ClientConfig.concurrency` rather than downstream latency |
| `METRICS.IN_FLIGHT` (`vereda.in_flight`) | gauge | — | Current in-flight executions across all partitions |
| `METRICS.CIRCUIT_OPEN` (`vereda.circuit_open`) | counter | `partition` | One per circuit breaker trip to open (opt-in feature; silent unless `circuitBreaker.enabled`) |

`examples/otel.ts` shows a minimal OpenTelemetry-backed `MetricsSink` implementation end to end. Lifecycle events (`client.on("request" | "retry" | "success" | "failure" | "cancelled" | "circuitOpen" | "circuitClose", ...)`) are the complementary hook for structured logging or alerting rather than metrics — see the README's [Lifecycle events](../README.md#lifecycle-events) section.

**`QUEUE_DEPTH`/`GLOBAL_QUEUE_DEPTH` are polled, not pushed on change** — they're read at request-start and at each ticket's terminal event, not at the moment a caller actually joins or leaves the wait queue. That reliably shows a *sustained* backlog (a dashboard/alert on "depth > N for 5 minutes" works as expected), but a single request that's briefly queued and released between those two polling points can be invisible to the gauge. For guaranteed per-request visibility regardless of backlog size, use `queuedMs` on the lifecycle events instead — it's measured at the point of acquisition, not polled.

## Shutdown sequence

```typescript
await client.close({ drain: true, timeoutMs: 30_000 });
```

- **`close()`** with no `drain` (or `drain: false`) cancels every in-flight ticket immediately and rejects new requests with `ConfigurationError("client closed")`. Use this for a hard, fast shutdown (e.g. `SIGKILL`-adjacent paths where you just need the process to exit without lingering timers).
- **`close({ drain: true, timeoutMs })`** waits for in-flight tickets to settle naturally, up to `timeoutMs`, then cancels whatever's left. Use this on graceful shutdown (`SIGTERM` handler) so requests that are about to succeed get the chance to.

Either way, all internal timers (backoff sleeps, `attemptMs`/`totalMs` deadlines) are `unref()`ed from the moment they're created, so a Vereda client never by itself keeps the Node event loop alive — `close()` is about resolving in-flight *tickets* cleanly, not about unblocking process exit.

Call `close()` once per client, before the process exits, in whichever shutdown handler your deployment already uses. Extra calls are harmless: a `close()` that arrives while a drain is in progress returns the same promise, so it resolves only when the shutdown actually finishes. `close({ drain: true })` without a positive `timeoutMs` rejects with a `ConfigurationError` and leaves the client open.

## Redaction

`redactQuery` defaults to `true`. With it on, every URL that appears in a lifecycle event, is passed to your `logger`, or is embedded in an error (`TimeoutError`/`DeadlineExceededError`'s `message` and `url`, and so `MaxRetriesExceededError.message` too) has its query *values* replaced with `[redacted]` (keys are preserved, so `?token=abc123` becomes `?token=[redacted]`), and any userinfo credentials (`https://user:pass@host`) replaced with `[redacted]@`. This covers the common case of API keys, session tokens, or PII passed in the URL. Request/response *headers* are never logged or emitted by Vereda regardless of this setting, so an `Authorization` header is never at risk of leaking into logs via the library itself.

Redaction only touches what Vereda itself surfaces (event payloads, log calls, error messages). The bundled `requestLogger()` middleware redacts the same way by default. Middleware can't see the client's config, so pass `requestLogger({ redactQuery: false })` to turn it off there too. If your own middleware logs `ctx`/`options` directly, or the raw `Response` (including `HttpError.response.url`) or request body contains sensitive data, redact that yourself before logging it. `redactUrl` is exported from `vereda` for that.

Set `redactQuery: false` only in trusted environments (e.g. local development against a mock server) where seeing full URLs in logs is worth more than the leak risk.
