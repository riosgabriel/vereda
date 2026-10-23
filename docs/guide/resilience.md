# Resilience

Retries, timeouts, per-host isolation and circuit breaking: the settings that decide how Vereda reacts when a dependency misbehaves. Back to the [README](../../README.md).

## Retries and backoff

> **See it run:** the [backoff and jitter simulator](https://vereda.dev/patterns/backoff-jitter/) plays this with and without the pattern.

Configure retries on the client or per request. Per-request settings override the client's.

**Example**

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

### What gets retried

By default, a failed attempt is retried only when the error is transient **and** the request is safe to repeat.

| Failure | `kind` | Retried by default |
| --- | --- | --- |
| Network failure | `network` | Yes, if idempotent |
| Attempt timed out | `timeout` | Yes, if idempotent |
| Busy status (`408, 425, 429, 500, 502, 503, 504`) | `retryable_status` | Yes, if idempotent |
| Any other HTTP status (e.g. `404`) | `http` | No |
| Response failed `parse` | `validation` | Never |
| Cancelled | `cancelled` | Never |
| Partition or global queue full | `queue_full` | Never |
| Circuit open | `circuit_open` | Never |
| Rate limit wait over `maxWaitMs` | `rate_limited` | Never |
| Invalid configuration | `configuration` | Never |

"If idempotent" means `GET`, `HEAD`, `OPTIONS`, `PUT` or `DELETE`, or a `POST`/`PATCH` sent with `retry: { idempotent: true }` or an `Idempotency-Key` header (see [Idempotent methods](#idempotent-methods)).

A [retry budget](#retry-budget), when configured, can also refuse a retry the policy allowed.

The busy-status list is `retry.retryOnStatus`. The underlying `defaultRetryPolicy` is exported, so you can inspect it or call it from inside `retryWhen`.

### Idempotent methods

`GET`, `HEAD`, `OPTIONS`, `PUT` and `DELETE` are idempotent, so they're retried.

`POST` and `PATCH` are not. Repeating them blindly could duplicate a side effect. To opt in, set `retry: { idempotent: true }`, send an `Idempotency-Key` header, or let Vereda generate one with [`idempotencyKey`](#generating-the-key-for-you).

**Example** (retrying a POST)

```typescript
client.post("/orders", () => JSON.stringify(order), {
  headers: { "Idempotency-Key": order.id },
});
```

### Generating the key for you

To skip writing the key yourself, set `retry: { idempotencyKey: true }`. Vereda makes one key per request with `crypto.randomUUID()`, before the first attempt, and sends that same key on every attempt as `Idempotency-Key`. The server can then tell a retry from a new order.

The option is off by default. It only applies to methods that are not already idempotent, and a header you set yourself always wins. Pass a function instead of `true` to build the key your own way; it is called once per request. If it throws or returns an empty string, the request fails with a `ConfigurationError`. The key is added even when `maxRetries` is `0`.

**Example** (a POST with an automatic key)

```typescript
client.post("/orders", () => JSON.stringify(order), {
  retry: { idempotencyKey: true },
});
```

### Replaying the body

A request `body` can be a factory, `() => BodyInit`. Vereda calls it fresh on every attempt, so the payload can be sent again on each retry.

A `ReadableStream` body needs a factory: passing a bare stream is a `ConfigurationError`. With a stream body, Vereda sets `duplex: "half"` on the fetch call for you.

### When retries run out

- `maxRetries: 0` disables retries. A failed request resolves with its own error, unwrapped.
- When retries run out and the last failure was still transient, the ticket resolves with `MaxRetriesExceededError`. It carries the attempt count and the last underlying error.
- When an attempt fails with a non-retryable error, that error is returned as is.

### Backoff

The default backoff is 200 ms × 2^attempt, capped at 30 s, with full jitter. Jitter spreads retries out, so a fleet of clients doesn't hit a recovering server at the same instant.

A retry of a `retryOnStatus` response honors its `Retry-After` header, in seconds or as an HTTP date. That delay is capped at `backoff.maxDelayMs` (30 s when `backoff` is a function) and gets no jitter. Without the header, the configured backoff sets the delay.

By default that delay applies only to the ticket that received the header. To hold every request to the host, see [Pausing on Retry-After](#pausing-on-retry-after).

**Example** (a custom backoff function)

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

### Vetoing a retry: `retryWhen`

`retryWhen` runs after every failed attempt that could still be retried, the first one included. It runs after the default policy and can only veto a retry, never force one.

Return `false` to surface the error at once.

**Example** (never retry network failures)

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

### Retry budget

> **See it run:** the [retry budget simulator](https://vereda.dev/patterns/retry-budget/) plays this with and without the pattern.

`maxRetries` bounds retries per request, not per host. When a host fails every request, each one still retries up to `maxRetries` times. The host sees `1 + maxRetries` times its normal load, right when it can least take it.

A retry budget caps retries to a fraction of the partition's recent traffic instead.

**Example**

```typescript
import { HttpClient } from "@vereda/http";

const client = HttpClient.create({
  timeout: { attemptMs: 5_000 },
  retryBudget: { ratio: 0.1, windowMs: 10_000, minRetriesPerSec: 10 },
  partitions: {
    "payments.internal": { retryBudget: { ratio: 0.2, windowMs: 10_000 } },
  },
});
```

A retry is allowed only while the partition's retries over the last `windowMs` stay below this limit, where `requests` counts first attempts:

```text
max(minRetriesPerSec × windowMs / 1000, ratio × requests)
```

- With `ratio: 0.1`, a failing host sees at most about 1.1 times its normal load.
- `minRetriesPerSec` (default 10) is a floor, so a partition with little traffic can still retry.
- Once the budget is spent, a ticket that would have retried fails at once with its last error, without waiting out the backoff. A `retryBudgetExhausted` event fires before its `failure` event.
- Retries that run free up budget again as they slide out of the window.

**Where to set it.** On the client or per partition, never per request. A partition's `retryBudget` overrides the client's field by field.

`retryBudget: false` turns the client's budget off for that partition, or for every unlisted one when set on `defaultPartition`. That suits an internal host where retries are cheap. With no budget at all, only `maxRetries` limits retries.

**Budget and breaker together.** They cover different stages of an outage:

| | Retry budget | [Circuit breaker](#circuit-breaker) |
| --- | --- | --- |
| Limits | Retries, while a host is degraded | Every attempt, once the host is clearly down |
| First attempts | Still go through | Blocked |
| Job | Keeps a retry storm from building | Stops traffic to a host that is down |

## Timeouts

> **See it run:** the [timeout simulator](https://vereda.dev/patterns/timeouts/) plays this with and without the pattern.

Vereda has two timeouts.

| | Bounds | On expiry |
| --- | --- | --- |
| `attemptMs` | One attempt | The attempt is aborted with `TimeoutError`, which is retryable |
| `totalMs` | The whole ticket, every attempt and backoff delay included | The in-flight attempt is aborted, and the ticket resolves with `DeadlineExceededError`, which is terminal |

**Example** (a client default, raised for one slow request)

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

The [operations guide](../operations.md) covers how to choose the two together.

### `attemptMs`

`attemptMs` is required on the client-level `timeout`. Pass `Infinity` to opt out of a cap explicitly.

Partition- and request-level `timeout` stay optional and inherit the client default.

### `totalMs`

When the deadline passes, the ticket resolves with `DeadlineExceededError`. It's reported as a `failure` event, not `cancelled`.

If the next retry's delay (backoff or `Retry-After`) would run to or past the deadline, the ticket fails with that error right away instead of sleeping first. Its `cause` holds the last attempt's error.

Omit `totalMs`, or pass `Infinity`, for no deadline.

### Largest value

A finite `attemptMs` or `totalMs` can be at most 2,147,483,647 ms (about 24.8 days), the longest delay `setTimeout` holds. A larger one fails with `ConfigurationError`. Use `Infinity` for no limit.

## Bulkhead isolation

> **See it run:** the [bulkhead simulator](https://vereda.dev/patterns/bulkhead/) plays this with and without the pattern.

Every request belongs to a partition, and each partition owns a concurrency limit plus a waiting queue. A failing host's retries fill its own partition queue, not other hosts'.

**Example**

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

### How requests are partitioned

By default, the key is the URL's host: the hostname, plus `:port` when it isn't the scheme's default.

- `http://api.example.com:8080` and `http://api.example.com:9090` land in separate partitions.
- For an https host on the default port, the `partitions` key is just `"api.example.com"`.

### Retries only

The partition's concurrency limit and queue govern only **retry traffic**. The first attempt skips them, unless `limitFirstAttempts` is set on the partition.

The first attempt still counts against the client-wide `concurrency` cap.

### Every other host: `defaultPartition`

A partition not listed under `partitions` uses `defaultPartition`, which takes the same fields. Use it to tune every other host at once.

A listed partition doesn't inherit from it.

**Example**

```typescript
import { HttpClient } from "@vereda/http";

const client = HttpClient.create({
  timeout: { attemptMs: 5_000 },
  defaultPartition: { concurrency: 3, retry: { maxRetries: 1 } }, // every unlisted host
  partitions: { "api.internal.com": { concurrency: 20 } }, // gets none of defaultPartition
});
```

### Naming a partition yourself

You can assign a partition explicitly. That isolates a group of requests, with its own retry bulkhead, breaker and `partitions[name]` config, or groups several hosts together.

It doesn't prioritize anything.

```typescript
client.get("/path", { partition: "high-priority" });
```

### When a queue is full

When a partition's queue, or the global queue, is full, the ticket resolves with `QueueFullError`. That's deliberate backpressure: the alternative is unbounded memory growth.

## Rate limiting

> **See it run:** the [rate limiter simulator](https://vereda.dev/patterns/rate-limiter/) plays this with and without the pattern.

A bulkhead caps how many attempts run at once. A rate limit caps how many *start* per second, which is what a third-party API with a requests-per-second quota needs.

It's a token bucket per partition.

**Example**

```typescript
import { HttpClient } from "@vereda/http";

const client = HttpClient.create({
  timeout: { attemptMs: 5_000, totalMs: 30_000 },
  partitions: {
    "api.partner.com": { rateLimit: { tokensPerSec: 10, burst: 20, maxWaitMs: 2_000 } },
  },
});
```

### How the bucket fills

Every attempt to the partition takes a token before it's sent, first attempts and retries alike.

The bucket holds up to `burst` tokens (default: one second's worth) and refills at `tokensPerSec`. After a quiet spell, `burst` attempts can go out back to back. After that, one goes out every `1 / tokensPerSec` seconds.

### Waiting for a token

When the bucket is empty, an attempt waits its turn, in arrival order.

It takes the token before any bulkhead slot or global `concurrency` permit, so it holds no concurrency while it waits. The wait counts toward `queuedMs`.

The wait ends early on `cancel()` or at `timeout.totalMs`, and the unused token goes back to the bucket.

### Failing fast: `maxWaitMs`

Without `maxWaitMs`, cancelling and `totalMs` are the only limits on the wait.

With it, an attempt that would wait longer fails at once with `RateLimitedError` (`kind: "rate_limited"`). The error carries the `waitMs` it would have needed, and it's never retried. A retry that hits it fails the ticket the same way.

### Where to set it

On the client, where it applies to each partition separately, or per partition. Never per request.

A partition's `rateLimit` overrides the client's field by field, and `rateLimit: false` turns the client's limit off for that partition.

A `429`'s `Retry-After` doesn't change the bucket unless you also turn on [pausing](#pausing-on-retry-after).

## Pausing on Retry-After

A server that answers `429` with `Retry-After` is telling every caller to wait. Without this option, only the ticket that got the response listens. Everything else keeps sending, and probably collects its own `429`.

`pauseOnRetryAfter` makes the whole partition listen. It's opt-in.

**Example**

```typescript
import { HttpClient } from "@vereda/http";

const client = HttpClient.create({
  timeout: { attemptMs: 5_000, totalMs: 30_000 },
  pauseOnRetryAfter: { maxPauseMs: 10_000 },
});
```

After a `429` or `503` with a valid `Retry-After`, nothing new goes to that partition before the time the server named. That covers first attempts and retries. A request that arrives meanwhile waits, and the wait counts toward `queuedMs`.

Requests that were already queued wait too. One that reaches the front of the partition's `concurrency` queue, or of the global one, during the pause goes back and waits it out. It sends nothing, and it doesn't count as an attempt.

### What pauses

- `statuses` lists the statuses that pause. The default is `[429, 503]`. A status also has to be in `retry.retryOnStatus`, which both are by default.
- `maxPauseMs` caps the pause (default 30 s). A longer `Retry-After` is clamped, so a buggy header can't park the partition for hours.
- The header is seconds or an HTTP date, in any of the three forms RFC 9110 allows. A missing, zero, past or unparseable value pauses nothing.
- A later `Retry-After` can extend the pause. It never shortens it.

### Waiting out a pause

A waiting request holds no bulkhead slot or global `concurrency` permit, as with a rate-limit token.

The wait ends early on `cancel()` or at `timeout.totalMs`. Without a [rate limit](#rate-limiting), those are its only limits besides the pause itself.

A retry waits for the longer of its own backoff delay and the pause. The `retry` event's `delayMs` (and a ticket's `retrying` update) reports that longer wait.

If the pause would run past the deadline, the ticket fails at once with `DeadlineExceededError`. That goes for a first attempt too.

### With a rate limit

The pause and the token wait add up, and `maxWaitMs` bounds both. A request that would wait longer fails at once with `RateLimitedError`, and nothing is sent. A retry that is sure to be refused once it has slept fails before it spends retry budget or emits a `retry` event.

When the pause is part of the reason, the error says so: its message names the pause, and `pausedUntil` holds the epoch ms it ends at. Without a pause, `pausedUntil` is `undefined`.

When a pause starts, the bucket drains. Traffic resumes at `tokensPerSec` after the pause, not in a burst.

**Example**

```typescript
import { HttpClient } from "@vereda/http";

const client = HttpClient.create({
  timeout: { attemptMs: 5_000, totalMs: 30_000 },
  rateLimit: { tokensPerSec: 10, maxWaitMs: 5_000 },
  pauseOnRetryAfter: { statuses: [429] },
});
```

### Where to set it

On the client, or per partition. A partition's setting overrides the client's field by field, and `pauseOnRetryAfter: false` turns it off for that partition.

`partitions()` reports `pausedUntil` (epoch ms) while a pause is active. A paused partition isn't pruned.

### The circuit breaker

The breaker is unchanged: a `429` still counts as a failure. If you want a throttled host to pause without tripping the breaker, exclude `429` with `isFailure`.

```typescript
import { HttpClient, RetryableStatusError } from "@vereda/http";

const client = HttpClient.create({
  timeout: { attemptMs: 5_000 },
  pauseOnRetryAfter: {},
  circuitBreaker: {
    enabled: true,
    isFailure: (error) => !(error instanceof RetryableStatusError && error.statusCode === 429),
  },
});
```

One limit: a first attempt takes its breaker permit before it waits out the pause. A half-open trial request therefore holds its permit through the pause, unless the pause alone would pass its deadline. Then it fails before taking one.

## Circuit breaker

> **See it run:** the [circuit breaker simulator](https://vereda.dev/patterns/circuit-breaker/) plays this with and without the pattern.

Once a host is clearly failing, stop sending it requests instead of retrying into it. The breaker is opt-in and works per partition.

It's off by default. Turn it on for every partition at the client level, or for specific hosts under `partitions`.

**Example**

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

### `enabled` in 1.x and 2.0

In 1.x, the breaker stays off until `enabled: true`, even when other `circuitBreaker` fields are set.

That changes in 2.0. Setting `circuitBreaker` will turn it on, as setting `retryBudget` or `rateLimit` does today, and only `enabled: false` will turn it off.

To keep your behavior across the upgrade, pass `enabled` explicitly, or remove a `circuitBreaker` config you don't mean to use.

### Open, half-open, closed

The breaker is checked before the first attempt and again before every retry. While it's open, requests to that partition fail with `CircuitOpenError` instead of sending the attempt that was due.

After `resetTimeoutMs`, one trial request is let through (`halfOpenMaxAttempts`). Success closes the circuit, and another failure reopens it.

### What counts as a failure

| Outcome | Counts as |
| --- | --- |
| A `network`, `timeout` or `retryable_status` error | A failure (override with `isFailure`) |
| Any other response, such as a `404` or a body that fails `parse` | A success: the host is up |
| An attempt that never reached the host, such as a body factory that threw | Ignored |

An ignored attempt carries no information about the host's health. So it can't reset a failing streak or close a half-open trial.

### Tripping on a failure rate

To trip on a rolling failure rate instead of consecutive failures, set `window`.

**Example**

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

When a half-open trial closes the circuit, the window starts empty. The breaker trips again only after `minimumRequests` new outcomes, not on the failures that opened it.

### Reading the state: `circuits()`

`client.circuits()` returns a snapshot of every enabled breaker that has seen a request, and `[]` when none is configured. Each entry is a copy, so changing it has no effect on the breaker.

**Example**

```typescript
import { HttpClient } from "@vereda/http";

const client = HttpClient.create({ timeout: { attemptMs: 5_000 }, circuitBreaker: { enabled: true } });

for (const { partition, state, failures, nextAttemptAt } of client.circuits()) {
  // state: "closed" | "open" | "half_open"; openedAt/nextAttemptAt are set unless closed
  console.log(partition, state, failures, nextAttemptAt);
}
```

- `failures` counts consecutive failures, or failures inside the rolling window when `window` is set.
- The move from open to half-open happens when a request arrives. A breaker with no traffic stays `open` after `nextAttemptAt` has passed, and the next request it admits becomes the half-open trial.
