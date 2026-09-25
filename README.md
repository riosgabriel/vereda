<p align="center">
  <img src="assets/logo.png" alt="Vereda" width="200" />
</p>

<h1 align="center">Vereda</h1>

<h3 align="center">Make <code>fetch</code> resilient.</h3>

<p align="center">
  Retries, backoff, timeouts, per-host isolation, and circuit breaking for Node.js <code>fetch</code> — with typed results instead of thrown errors.
</p>

<p align="center">
  <a href="https://github.com/riosgabriel/vereda/actions/workflows/ci.yml"><img src="https://github.com/riosgabriel/vereda/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="https://github.com/riosgabriel/vereda/blob/main/LICENSE"><img src="https://img.shields.io/github/license/riosgabriel/vereda" alt="License" /></a>
  <a href="https://nodejs.org/en/about/previous-releases"><img src="https://img.shields.io/badge/node-20%2B-green" alt="Node 20+" /></a>
  <a href="https://github.com/riosgabriel/vereda"><img src="https://img.shields.io/badge/ESM-only-blue" alt="ESM only" /></a>
  <a href="https://github.com/riosgabriel/vereda"><img src="https://img.shields.io/badge/TypeScript-6.0-blue" alt="TypeScript" /></a>
  <a href="https://github.com/riosgabriel/vereda/blob/main/package.json"><img src="https://img.shields.io/badge/dependencies-0-brightgreen" alt="Zero runtime dependencies" /></a>
</p>

```typescript
import { HttpClient } from "vereda";

const api = HttpClient.create({
  baseUrl: "https://api.example.com",
  timeout: { attemptMs: 5_000 },
});

const result = await api.get("/users/42").toPromise(); // never rejects

if (result.success) {
  const user = await result.raw.json();
} else {
  console.error(result.error.kind, result.error.message); // a typed error
}
```

A dropped connection, a timeout, or a `503` on that request is retried up to three times with jittered exponential backoff before your code sees an error. Reading `result.raw` afterwards is bounded too: the body read has to finish within the same `attemptMs` (counted from when the attempt started) and `totalMs` limits, or the read rejects with Vereda's own `TimeoutError` (attempt bound) or `DeadlineExceededError` (`totalMs` bound).

## Why Vereda?

`fetch` makes one attempt. Everything after that is yours to write:

```typescript
async function getUser(id: string) {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(`https://api.example.com/users/${id}`, {
        signal: AbortSignal.timeout(5_000),
      });
      if (res.ok) return await res.json();
      throw new Error(`HTTP ${res.status}`); // 404 or 503? retry both?
    } catch (err) {
      // timeout, DNS failure, or the throw above? caught all the same
      // is this request safe to repeat? what if it were a POST?
      if (attempt === 3) throw err;
    }
    await new Promise((r) => setTimeout(r, 200 * 2 ** attempt)); // jitter? Retry-After?
  }
}
```

Even once that loop is correct, it has no limit on how many retries pile onto a struggling host, no way to cancel, and callers that can only tell a `404` from a timeout by parsing an error message. Vereda is that loop written carefully, once:

| When… | Vereda… |
| --- | --- |
| A request fails transiently (connection reset, timeout, `408`, `425`, `429`, `500`, `502`–`504`) | retries it with exponential backoff and full jitter, honoring `Retry-After` |
| A retry could duplicate a side effect | retries only idempotent methods unless you opt in or send an `Idempotency-Key` |
| A request hangs | aborts each attempt at `timeout.attemptMs`; an optional `timeout.totalMs` caps the whole request |
| One failing host would soak up your retries | caps retry concurrency and queue size per host, so one host's retries can't fill another's queue (all hosts still share the global `concurrency` cap) |
| A host is down, not just slow | an opt-in circuit breaker fails fast with `CircuitOpenError` until it recovers |
| The response isn't the shape you expected | validates it with your `parse` function (or Zod); a failed parse is never retried |
| The caller no longer needs the answer | cancels via the ticket or your `AbortSignal`; a cancelled request is never retried |
| You need to know what happened | emits typed lifecycle events (with attempt counts and queue time) and metrics (requests, retries, latency, in-flight, queue depth, breaker trips) |
| You need auth headers, logging, URL rewriting | runs onion middleware around every attempt |

**What Vereda does not do.** No response caching, no request deduplication, no streaming helpers, no browser support. It targets Node.js 20+ services that depend on other services; for a handful of calls in a script, plain `fetch` is fine.

## Quick start

```bash
npm install vereda
```

```typescript
import { HttpClient, json } from "vereda";

type User = { id: number; name: string };

const api = HttpClient.create({
  baseUrl: "https://api.example.com",
  timeout: { attemptMs: 5_000 },
});

const result = await api.get("/users/42", { parse: json<User>() }).toPromise();

if (result.success) {
  result.data.name; // typed: string
} else {
  switch (result.error.kind) {
    case "http": // non-retryable status, e.g. 404
      console.warn(result.error.statusCode);
      break;
    case "max_retries": // transient failures outlasted every retry
      console.error(result.error.lastError);
      break;
    default:
      console.error(result.error.message);
  }
}
```

`toPromise()` never rejects: every outcome is a `Result`, and every failure is one of a closed set of error classes, discriminated by `kind` ([Error handling](#error-handling)). `json<T>()` casts without checking; pass a real validator, or use the [Zod adapter](#zod-adapter-optional), when you need the shape enforced.

**`timeout.attemptMs` is the one required setting.** Most HTTP clients have no overall request timeout by default, which is how one hung dependency takes a service down. Vereda makes you choose a number, or pass `Infinity` to opt out on purpose. Everything else has a default:

| Setting | Default |
| --- | --- |
| Retries | 3 retries after the first attempt (4 total executions) |
| Backoff | Exponential: 200ms base, 30s cap, full jitter |
| Retry-on status codes | `[408, 425, 429, 500, 502, 503, 504]` |
| Per-partition concurrency | 5 retries in flight per host |
| Per-partition queue size | 100 waiting retries per host |
| Global concurrency | 50 in-flight executions across all partitions |
| Global queue size | 100 waiting executions; beyond that a request resolves with `QueueFullError` (`partition: "global"`) |
| First attempts | Skip the per-partition bulkhead (unless `partition.limitFirstAttempts` is set), but still take a global permit |
| Total deadline | None — set `timeout.totalMs` to cap the whole request |
| Circuit breaker | Disabled — opt in with `circuitBreaker: { enabled: true }` |

## Example: one failing dependency

A checkout service calls three hosts. The payment provider starts returning `503`.

```typescript
import { HttpClient } from "vereda";

const client = HttpClient.create({
  timeout: { attemptMs: 3_000, totalMs: 15_000 },
  partitions: {
    "payments.example.com": {
      concurrency: 2,
      maxQueueSize: 20,
      circuitBreaker: { enabled: true, failureThreshold: 5, resetTimeoutMs: 30_000 },
    },
  },
});

// POST isn't retried by default; the idempotency key tells Vereda a repeat is safe.
const charge = client.post("https://payments.example.com/charges", JSON.stringify(order), {
  headers: { "Content-Type": "application/json", "Idempotency-Key": order.id },
});
```

```
checkout service
  │
  ├──► payments.example.com    503, 503, 503 …
  │      retries: at most 2 in flight, 20 waiting, the rest fail fast with QueueFullError
  │      after 5 straight failures: circuit opens, calls fail instantly with CircuitOpenError
  │      after 30s: one trial request; success closes the circuit
  │
  ├──► inventory.example.com   own partition: its retries aren't queued behind payments'
  └──► shipping.example.com    own partition: same
```

Every request is assigned to a partition by host, and each partition has its own retry queue and its own breaker. Payments' retries are capped at 2 in flight, and once its breaker opens, payment calls stop reaching the network, apart from the half-open trial and any retry that had already passed the breaker check before its backoff. The `totalMs` deadline means no single call waits longer than 15 seconds, retries included.

One limit is shared: every attempt, first attempts included, takes a permit from the client-wide `concurrency` cap (default 50, with 100 waiting). A host that fails *slowly* holds those permits while it hangs, so under enough load it can delay or reject requests to healthy hosts. Keep `attemptMs` short for dependencies that tend to hang, and set `limitFirstAttempts: true` on a partition to put its fresh traffic behind its own bulkhead too.

[`examples/checkout/`](examples/checkout/) is this scenario as a runnable app: stub upstreams on localhost, a small checkout server, and a driver that asserts the retries and the breaker tripping while inventory and shipping keep succeeding (sequential traffic and smaller numbers, so it runs fast; it doesn't exercise the queue limits). Clone the repo and run `npm run example:checkout`.

## How it works

```
client.get(url)
      │
      ▼
 breaker check ─> global permit ─> first attempt
                                        │
      ┌────────────────────────────────►┤ outcome of each attempt
      │                                 ├─ success ─────────────────> done
      │                                 ├─ non-retryable or vetoed ─> resolves with that error
      │                                 ├─ transient, none left ────> MaxRetriesExceededError
      │                                 └─ transient, retries left
      │                                          │
      │   breaker check ─> backoff ─> partition bulkhead ─> global permit ─> retry
      │                                (per host)                             │
      └───────────────────────────────────────────────────────────────────────┘
```

The first attempt skips the partition bulkhead. Only requests that need another attempt go through their partition's queue, so a host's retry backlog waits in its own partition queue, not ahead of other hosts' retries. Once admitted, a retry still needs a permit from the global `concurrency` cap, which it waits for alongside fresh requests. When the circuit breaker is enabled, it is checked before the first attempt and again before every retry.

## Features

### Retries and backoff

Configure retries globally or per request. Per-request settings override global ones.

#### What gets retried

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

Idempotent means `GET`, `HEAD`, `OPTIONS`, `PUT`, `DELETE`, or `TRACE`. Non-idempotent methods (`POST`, `PATCH`, `CONNECT`) are not retried, since blindly repeating them could duplicate a side effect; opt in with `retry: { idempotent: true }` or by sending an `Idempotency-Key` header. The busy-status list is `retry.retryOnStatus`, and the underlying `defaultRetryPolicy` is exported for inspection, or to call from inside `retryWhen`.

`maxRetries: 0` disables retries entirely — a failed request resolves with its own error, unwrapped. When retries run out and the last failure was still transient, the ticket resolves with a `MaxRetriesExceededError` carrying the attempt count and the last underlying error. If an attempt fails with a non-retryable error, that error is returned as is.

```typescript
import { HttpClient } from "vereda";

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
import { HttpClient } from "vereda";

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
import { HttpClient, NetworkError } from "vereda";

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

### Timeouts

```typescript
import { HttpClient } from "vereda";

const client = HttpClient.create({
  timeout: {
    attemptMs: 5_000,
    totalMs: 20_000,
  },
});

client.get("/reports/slow", { timeout: { attemptMs: 15_000 } });
```

- `attemptMs` — a hard per-attempt timeout. The attempt is aborted with a `TimeoutError`, which is retryable. Required on the client-level `timeout` config — pass `Infinity` to explicitly opt out of a cap. Partition- and request-level `timeout` stay optional and inherit the client default.
- `totalMs` — a deadline for the whole ticket, across every attempt and backoff delay. On expiry the in-flight attempt is aborted and the ticket resolves with a `DeadlineExceededError` (a `failure` event, not `cancelled`), which is terminal. Omit it (or pass `Infinity`) for no deadline.

The [operations guide](docs/operations.md) covers how to choose the two together.

### Bulkhead isolation

Every request is assigned to a partition, keyed by URL host by default: the hostname, plus `:port` when it isn't the scheme's default. `http://api.example.com:8080` and `http://api.example.com:9090` land in separate partitions, and a `partitions` key for an https host on the default port is just `"api.example.com"`. Each partition owns a concurrency limit plus a waiting queue. A failing host's retries fill its own partition queue, not other hosts'.

The partition's concurrency limit and queue govern only **retry traffic** — the initial attempt skips them (unless `limitFirstAttempts` is set on the partition). It still counts against the client-wide `concurrency` cap.

```typescript
import { HttpClient } from "vereda";

const client = HttpClient.create({
  timeout: { attemptMs: 5_000 },
  concurrency: 10, // client-wide cap across all partitions, first attempts included
  partitions: {
    "api.external.com": { concurrency: 2, maxQueueSize: 10 },
    "api.internal.com": { concurrency: 20 },
  },
});
```

You can assign a partition explicitly, to isolate a group of requests (its own retry bulkhead, breaker, and `partitions[name]` config) or to group hosts. It doesn't prioritize anything:

```typescript
client.get("/path", { partition: "high-priority" });
```

When a partition's queue, or the global queue, is full, the ticket resolves with a `QueueFullError`. That is deliberate backpressure: the alternative is unbounded memory growth.

### Circuit breaker

Opt-in, per-partition. Once a host is clearly failing, stop sending it requests instead of retrying into it. Disabled by default; enable it for every partition at the client level, or for specific hosts under `partitions`.

```typescript
import { HttpClient } from "vereda";

const client = HttpClient.create({
  timeout: { attemptMs: 5_000 },
  circuitBreaker: {
    enabled: true,
    failureThreshold: 5, // consecutive failures that trip it open
    resetTimeoutMs: 30_000, // how long to stay open before a half-open trial
  },
});
```

The breaker is checked before the first attempt and again before every retry — while open, requests to that partition fail with `CircuitOpenError` instead of sending the attempt that was due. After `resetTimeoutMs`, one trial request is let through (`halfOpenMaxAttempts`); success closes the circuit, another failure reopens it. Only `network`, `timeout`, and `retryable_status` errors count as failures (override with `isFailure`). Any other response, such as a 404 or a body that fails `parse`, shows the host is up and counts as a success.

Trip on a rolling failure rate instead of consecutive failures:

```typescript
import { HttpClient } from "vereda";

const client = HttpClient.create({
  timeout: { attemptMs: 5_000 },
  circuitBreaker: {
    enabled: true,
    window: { sizeMs: 60_000, minimumRequests: 20, failureRatePercent: 50 },
  },
});
```

### Typed results

Pass a `parse` function to validate and type the response body. `parse` is just `(data: unknown) => T`, and any validator that throws on failure works. A failed parse resolves the ticket with a `ValidationError` and is never retried. With `parse` set, so does a body that isn't valid JSON, including an empty one (a `204`, or any `HEAD` response): the server answered, and asking again would get the same answer.

```typescript
const ticket = client.get<User>("/users/1", {
  parse: (data) => data as User, // or your own throwing validator
});

const result = await ticket.toPromise();
if (result.success) {
  result.data.name; // typed: string
}
```

`json<T>()` is the built-in, dependency-free version of that cast.

#### Zod adapter (optional)

Zod is an optional peer dependency. Only the `vereda/zod` entry point imports it; the core has zero dependencies. Vereda ships a Zod adapter for it:

```typescript
import { z } from "zod";
import { withZod } from "vereda/zod";

const UserSchema = z.object({
  id: z.number(),
  name: z.string(),
  email: z.email(),
});

const ticket = client.get("/users/1", { parse: withZod(UserSchema) });

const result = await ticket.toPromise();
if (result.success) {
  result.data.name; // typed: string
}
```

### Error handling

Errors are a closed hierarchy under `RequestError`, and `AppError` is the union of all of them. Every class carries a readonly, literal-typed `kind`, so switching on it narrows to that class and its fields (`instanceof` works too):

| Error | `kind` | Meaning | Notable fields |
| --- | --- | --- | --- |
| `NetworkError` | `"network"` | Request failed before a response arrived (DNS, connection reset, etc.) | `cause` |
| `HttpError` | `"http"` | Non-2xx response outside `retry.retryOnStatus` (e.g. `404`) | `statusCode`, `response` |
| `RetryableStatusError` | `"retryable_status"` | Non-2xx response matching `retry.retryOnStatus` (e.g. `503`) | `statusCode`, `response` (status and headers only; its body was cancelled), `retryAfterMs?` |
| `TimeoutError` | `"timeout"` | Attempt exceeded `timeout.attemptMs` | `url`, `timeoutMs` |
| `DeadlineExceededError` | `"deadline"` | Ticket exceeded `timeout.totalMs` (terminal — not retried) | `url`, `totalMs` |
| `ValidationError` | `"validation"` | Response body failed `parse` or isn't valid JSON (terminal — never retried) | `issues`, `cause` |
| `CancelledError` | `"cancelled"` | Ticket cancelled or signal aborted (terminal) | — |
| `QueueFullError` | `"queue_full"` | A partition's retry queue, or the global queue (`partition: "global"`), was full (terminal) | `partition`, `queueSize`, `maxQueueSize` |
| `CircuitOpenError` | `"circuit_open"` | The partition's breaker was open when an attempt was due, so it wasn't sent; earlier attempts may have run (terminal) | `partition` |
| `ConfigurationError` | `"configuration"` | A bare `ReadableStream` body, or a body factory that threw (terminal). Invalid client config throws from `create()` instead | `key` |
| `MaxRetriesExceededError` | `"max_retries"` | Retries ran out while the failure was still transient (terminal) | `attempts`, `lastError` |

Only `network`, `timeout`, and `retryable_status` are retried by default — see [What gets retried](#what-gets-retried) above. Everything else is terminal: it resolves the ticket on the first attempt that produces it.

`TimeoutError` and `DeadlineExceededError` can also arrive outside a `Result`: as the rejection of a body read performed later, on `result.raw` or `HttpError.response` (see the hero example above) — not only as `result.error`.

```typescript
const result = await ticket.toPromise();
if (!result.success) {
  switch (result.error.kind) {
    case "max_retries":
      result.error.lastError; // MaxRetriesExceededError: the final attempt's error
      break;
    case "http":
      result.error.statusCode; // HttpError: also .response
      break;
    case "circuit_open":
      result.error.partition; // CircuitOpenError: the partition that is failing fast
      break;
    default:
      console.error(result.error.message);
  }
}
```

Because the set is closed, a `switch` with a `const unreachable: never = result.error` default fails to compile if a case is missing.

### Cancellation

Cancel from the ticket, or wire in your own `AbortSignal`:

```typescript
const ticket = client.get("/slow-api/data");
ticket.cancel();

const controller = new AbortController();
const ticket2 = client.get("/api/data", { signal: controller.signal });
controller.abort(); // ticket resolves with CancelledError
```

Cancellation wins over everything else. A cancelled request is never retried.

To shut a client down, `client.close()` cancels everything in flight; `client.close({ drain: true, timeoutMs })` waits for in-flight tickets first, then cancels whatever is left. Either way, new requests throw `ConfigurationError("client closed")`. See the [shutdown sequence](docs/operations.md#shutdown-sequence) in the operations guide.

### Tickets

Every request method returns a **Ticket** synchronously — a handle to a request that may take several attempts. Most code only calls `toPromise()`. When you need to watch a request progress through its retries, or stop it partway, the ticket is also what you subscribe to and cancel.

```typescript
const ticket = client.get("/api/data");

// Await the terminal result
const result = await ticket.toPromise();

// Or follow every state change
for await (const update of ticket.subscribe()) {
  // { type: "queued" }
  // { type: "retrying", attempt, delayMs }
  // { type: "done", result }
  // { type: "cancelled" }
}

// Or cancel mid-flight
ticket.cancel();
```

The result is a discriminated union:

```typescript
type Result<T> =
  | { success: true; data: T; raw: Response }
  | { success: false; error: AppError };
```

A promise is a single future value. A resilient request has a lifecycle — queued, retrying, done — and a ticket exposes that lifecycle while `toPromise()` stays available for code that just wants the answer.

### Middleware

Middleware wraps every attempt (including retries) in the standard onion shape. Each middleware receives a `RequestContext` — `{ url, method, headers, body, signal, attempt, ticketId, partition }`, where `headers` is a real `Headers` instance — and a `next` function that calls the next middleware (or the actual fetch):

```typescript
import { defaultHeaders, requestLogger } from "vereda/middleware";

client.use(defaultHeaders({ Authorization: "Bearer token123" }));
client.use(requestLogger()); // redacts URL query values/credentials by default

client.use(async (ctx, next) => {
  console.log("Request:", ctx.url, "attempt", ctx.attempt);
  const response = await next(ctx);
  console.log("Response:", response.status);
  return response;
});
```

Middleware can rewrite `ctx.url` before calling `next(ctx)` — whatever URL survives to the innermost middleware is what actually gets fetched. `defaultHeaders()` only sets a header the request doesn't already have; the comparison is case-insensitive, so a request-level `authorization` header always wins over a default `Authorization` one and you never end up sending both.

Middleware receives the same `AbortSignal` the request uses (`ctx.signal`), so it can participate in timeout and cancellation handling — but only if it observes or forwards that signal to the work it performs. When a response is handed back unread, the same signal can still abort later, when the body-read bound expires.

### Lifecycle events

The client emits typed events across all requests, useful for metrics, logging, and alerting. Exactly one of `success`, `failure`, or `cancelled` fires per ticket:

```typescript
client.on("request",   ({ ticketId, url, method, partition }) => {});
client.on("retry",     ({ ticketId, url, attempt, delayMs, error }) => {});
client.on("success",   ({ ticketId, url, attempts, durationMs, queuedMs, statusCode }) => {});
client.on("failure",   ({ ticketId, url, attempts, durationMs, queuedMs, error }) => {});
client.on("cancelled", ({ ticketId, url, attempts, durationMs, queuedMs }) => {});
```

`retry`'s `attempt` is a zero-based retry index (`0` = the first retry, after the initial attempt). `off(event, listener)` removes a listener with the same signature as `on`. A listener (or `metrics` sink) that throws never affects the request: every other listener still runs, and the error is rethrown on a microtask, so it surfaces through `process.on("uncaughtException")` the same way a throwing `EventEmitter` listener would.

`queuedMs` is the total time this ticket spent waiting for a bulkhead/global-semaphore permit, summed across every attempt — it's `0` when a request never had to wait (the default global cap is 50 concurrent, so most single-service consumers never hit it). A consistently nonzero `queuedMs` relative to `durationMs` means you're throttled by `concurrency`/a partition's `concurrency`, not by downstream latency; see [Wiring a metrics sink](docs/operations.md#wiring-a-metrics-sink) for the companion `vereda.queue_depth` / `vereda.global_queue_depth` gauges.

If the circuit breaker is enabled, a partition also fires `circuitOpen`/`circuitClose` independently of any single ticket:

```typescript
client.on("circuitOpen",  ({ partition }) => {});
client.on("circuitClose", ({ partition }) => {});
```

## Design philosophy

**Fresh traffic comes first.** The first attempt skips the partition bulkhead, which exists to throttle *retry* pressure onto struggling hosts — that's where thundering herds come from.

**Backpressure beats unbounded queues.** When a queue is full, fail explicitly rather than consuming infinite memory.

**Cancellation is final.** A cancelled request never enters the retry loop, regardless of timeout or retry configuration.

**Validation failures aren't transient.** A response that fails your `parse` function resolves immediately — retrying would parse the same payload again.

**No silent infinite waits.** The per-attempt timeout is the one setting without a default, because a missing timeout is the failure you only find in production.

## Documentation

- **[Operations guide](docs/operations.md)** — sizing concurrency and queues, `attemptMs` vs. `totalMs`, reading `partitions()`, wiring a metrics sink, the shutdown sequence, and log redaction.
- **[API reference](https://riosgabriel.github.io/vereda/)** — generated from source via TypeDoc on every push to `main`; every public option documents its default.

## Versioning and support

Vereda follows [Semantic Versioning](https://semver.org/) from `1.0.0` onward: breaking changes land only in a major version, and anything scheduled for removal is deprecated in a minor release first and noted in [CHANGELOG.md](CHANGELOG.md) before it goes. The public surface is exactly what `src/core/index.ts`, `src/middleware/index.ts`, and `src/adapters/zod.ts` export — anything under `src/queue/` and `src/ticket/` that those entry points don't re-export is internal, even though it's readable source.

**Node support:** the currently supported line is whatever `engines.node` in `package.json` declares (`>=20` today); CI runs the full suite against Node 20, 22, and 24 on every change, so those three are the versions actually verified. The floor moves only in a major release.

## Contributing

New to Vereda? Two on-ramps:

- **Self-guided** — read [ONBOARDING.md](ONBOARDING.md), a tour that follows one request through the library.
- **Interactive** — run the **`guide-me`** skill in your coding harness (Claude Code, OpenCode, etc.). It's bundled in the repo and walks you through the internals interactively.

When you're ready, read [CONTRIBUTING.md](CONTRIBUTING.md) for setup, commands, and the behavioral invariants your change must preserve. Tests are self-contained: no network, services, or env vars needed.

## Why the name?

**Vereda** is Brazilian Portuguese for a narrow trail: a resilient route through terrain. That maps directly to what the library does: give your requests a reliable path through flaky networks, retries, and backpressure. *veh-REH-da.*

## License

MIT
