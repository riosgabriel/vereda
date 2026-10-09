# Resilience

Retries, timeouts, per-host isolation, and circuit breaking: the settings that decide how Vereda reacts when a dependency misbehaves. Back to the [README](../../README.md).

## Retries and backoff

Configure retries globally or per request. Per-request settings override global ones.

### What gets retried

By default, a failed attempt is retried only when the error is transient **and** the request is safe to repeat:

| Failure | `kind` | Retried by default |
| --- | --- | --- |
| Network failure | `network` | Yes — idempotent requests |
| Attempt timed out | `timeout` | Yes — idempotent requests |
| Busy status (`408, 425, 429, 500, 502, 503, 504`) | `retryable_status` | Yes — idempotent requests |
| Any other HTTP status (e.g. `404`) | `http` | No |
| Response failed `parse` | `validation` | Never |
| Cancelled | `cancelled` | Never |
| Partition or global queue full | `queue_full` | Never |
| Circuit open | `circuit_open` | Never |
| Invalid configuration | `configuration` | Never |

Idempotent means `GET`, `HEAD`, `OPTIONS`, `PUT`, or `DELETE`. Non-idempotent methods (`POST`, `PATCH`) are not retried, since blindly repeating them could duplicate a side effect; opt in with `retry: { idempotent: true }` or by sending an `Idempotency-Key` header. The busy-status list is `retry.retryOnStatus`, and the underlying `defaultRetryPolicy` is exported for inspection, or to call from inside `retryWhen`.

`maxRetries: 0` disables retries entirely — a failed request resolves with its own error, unwrapped. When retries run out and the last failure was still transient, the ticket resolves with a `MaxRetriesExceededError` carrying the attempt count and the last underlying error. If an attempt fails with a non-retryable error, that error is returned as is.

```typescript
import { HttpClient } from "@vereda/http";

const client = HttpClient.create({
  timeout: { attemptMs: 5_000 },
  retry: {
    maxRetries: 5,
    retryOnStatus: [429, 503],
    backoff: {
      baseDelayMs: 1000,
      maxDelayMs: 30000,
      jitter: true,
    },
  },
});
```

The default backoff is `200ms * 2^attempt`, capped at 30s, with full jitter applied. Jitter spreads retries out so a fleet of clients doesn't hit a recovering server at the same instant. Retries of a `retryOnStatus` response honor its `Retry-After` header (seconds or HTTP-date), capped at `backoff.maxDelayMs` (30s when `backoff` is a function) and without jitter; without one, the configured backoff drives the delay.

You can also supply a custom backoff function:

```typescript
import { HttpClient } from "@vereda/http";

const client = HttpClient.create({
  timeout: { attemptMs: 5_000 },
  retry: {
    maxRetries: 3,
    backoff: (attempt) => Math.min(100 * 2 ** attempt, 10000),
  },
});
```

`retryWhen` is consulted once after every failed attempt that could still be retried, including the first one. It runs after the default policy and can only veto a retry, never force one. Return `false` to surface the error immediately:

```typescript
import { HttpClient, NetworkError } from "@vereda/http";

const client = HttpClient.create({
  timeout: { attemptMs: 5_000 },
  retry: {
    maxRetries: 5,
    retryWhen: (error, attempt) => {
      if (error instanceof NetworkError) return false;
      return true;
    },
  },
});
```

A request `body` may also be supplied as a factory (`() => BodyInit`); the factory is invoked fresh on every attempt so the payload can be replayed across retries. This is required when the body is a `ReadableStream` — passing a bare stream is a `ConfigurationError`. When a stream body is used, `duplex: "half"` is set on the fetch call automatically.

## Timeouts

```typescript
import { HttpClient } from "@vereda/http";

const client = HttpClient.create({
  timeout: {
    attemptMs: 5_000,
    totalMs: 20_000,
  },
});

client.get("/reports/slow", { timeout: { attemptMs: 15_000 } });
```

- `attemptMs` — a hard per-attempt timeout. The attempt is aborted with a `TimeoutError`, which is retryable. Required on the client-level `timeout` config — pass `Infinity` to explicitly opt out of a cap. Partition- and request-level `timeout` stay optional and inherit the client default.
- `totalMs` — a deadline for the whole ticket, across every attempt and backoff delay. On expiry the in-flight attempt is aborted and the ticket resolves with a `DeadlineExceededError` (a `failure` event, not `cancelled`), which is terminal. When the next retry's delay (backoff or `Retry-After`) would run to or past the deadline, the ticket fails with that error right away instead of sleeping first, and `cause` holds the last attempt's error. Omit `totalMs` (or pass `Infinity`) for no deadline.

The [operations guide](../operations.md) covers how to choose the two together.

## Bulkhead isolation

Every request is assigned to a partition, keyed by URL host by default: the hostname, plus `:port` when it isn't the scheme's default. `http://api.example.com:8080` and `http://api.example.com:9090` land in separate partitions, and a `partitions` key for an https host on the default port is just `"api.example.com"`. Each partition owns a concurrency limit plus a waiting queue. A failing host's retries fill its own partition queue, not other hosts'.

The partition's concurrency limit and queue govern only **retry traffic** — the initial attempt skips them (unless `limitFirstAttempts` is set on the partition). It still counts against the client-wide `concurrency` cap.

```typescript
import { HttpClient } from "@vereda/http";

const client = HttpClient.create({
  timeout: { attemptMs: 5_000 },
  concurrency: 10, // client-wide cap across all partitions, first attempts included
  partitions: {
    "api.external.com": { concurrency: 2, maxQueueSize: 10 },
    "api.internal.com": { concurrency: 20 },
  },
});
```

A partition not listed under `partitions` uses `defaultPartition`, which takes the same fields. Use it to tune every other host at once. A listed partition doesn't inherit from it:

```typescript
import { HttpClient } from "@vereda/http";

const client = HttpClient.create({
  timeout: { attemptMs: 5_000 },
  defaultPartition: { concurrency: 3, retry: { maxRetries: 1 } }, // every unlisted host
  partitions: { "api.internal.com": { concurrency: 20 } }, // gets none of defaultPartition
});
```

You can assign a partition explicitly, to isolate a group of requests (its own retry bulkhead, breaker, and `partitions[name]` config) or to group hosts. It doesn't prioritize anything:

```typescript
client.get("/path", { partition: "high-priority" });
```

When a partition's queue, or the global queue, is full, the ticket resolves with a `QueueFullError`. That is deliberate backpressure: the alternative is unbounded memory growth.

## Circuit breaker

Opt-in, per-partition. Once a host is clearly failing, stop sending it requests instead of retrying into it. Disabled by default; enable it for every partition at the client level, or for specific hosts under `partitions`.

```typescript
import { HttpClient } from "@vereda/http";

const client = HttpClient.create({
  timeout: { attemptMs: 5_000 },
  circuitBreaker: {
    enabled: true,
    failureThreshold: 5, // consecutive failures that trip it open
    resetTimeoutMs: 30_000, // how long to stay open before a half-open trial
  },
});
```

The breaker is checked before the first attempt and again before every retry — while open, requests to that partition fail with `CircuitOpenError` instead of sending the attempt that was due. After `resetTimeoutMs`, one trial request is let through (`halfOpenMaxAttempts`); success closes the circuit, another failure reopens it. Only `network`, `timeout`, and `retryable_status` errors count as failures (override with `isFailure`). Any other response, such as a 404 or a body that fails `parse`, shows the host is up and counts as a success. An attempt that never reached the host at all — a body factory that threw, for instance — is ignored instead: it carries no information about the host's health, so it can't reset a failing streak or close a half-open trial.

Trip on a rolling failure rate instead of consecutive failures:

```typescript
import { HttpClient } from "@vereda/http";

const client = HttpClient.create({
  timeout: { attemptMs: 5_000 },
  circuitBreaker: {
    enabled: true,
    window: { sizeMs: 60_000, minimumRequests: 20, failureRatePercent: 50 },
  },
});
```

`client.circuits()` returns a snapshot of every enabled breaker that has seen a request, and `[]` when none is configured. Each entry is a copy, so changing it has no effect on the breaker:

```typescript
import { HttpClient } from "@vereda/http";

const client = HttpClient.create({ timeout: { attemptMs: 5_000 }, circuitBreaker: { enabled: true } });

for (const { partition, state, failures, nextAttemptAt } of client.circuits()) {
  // state: "closed" | "open" | "half_open"; openedAt/nextAttemptAt are set unless closed
  console.log(partition, state, failures, nextAttemptAt);
}
```

`failures` counts consecutive failures, or failures inside the rolling window when `window` is set. The move from open to half-open happens when a request arrives, so a breaker with no traffic stays `open` after `nextAttemptAt` has passed. The next request it admits becomes the half-open trial.
