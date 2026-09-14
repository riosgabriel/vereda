<p align="center">
  <img src="assets/logo.png" alt="Vereda" width="200" />
</p>

<h1 align="center">Vereda</h1>

<h3 align="center">Make <code>fetch</code> resilient.</h3>

<p align="center">
  Retries · Backoff · Bulkheads · Circuit Breaker · Timeouts · Typed Results
</p>

<p align="center">
  <a href="https://github.com/riosgabriel/vereda/actions/workflows/ci.yml"><img src="https://github.com/riosgabriel/vereda/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="https://github.com/riosgabriel/vereda/blob/main/LICENSE"><img src="https://img.shields.io/github/license/riosgabriel/vereda" alt="License" /></a>
  <a href="https://github.com/riosgabriel/vereda"><img src="https://img.shields.io/github/stars/riosgabriel/vereda?style=social" alt="GitHub stars" /></a>
  <a href="https://nodejs.org/en/about/previous-releases"><img src="https://img.shields.io/badge/node-20%2B-green" alt="Node 20+" /></a>
  <a href="https://github.com/riosgabriel/vereda"><img src="https://img.shields.io/badge/ESM-only-blue" alt="ESM only" /></a>
  <a href="https://github.com/riosgabriel/vereda"><img src="https://img.shields.io/badge/TypeScript-6.0-blue" alt="TypeScript" /></a>
</p>

```typescript
import { HttpClient } from "vereda";

const client = HttpClient.create({
  baseUrl: "https://api.example.com",
  retry: { maxRetries: 5 },
  timeout: { attemptMs: 5_000 },
  partitions: {
    "api.example.com": { concurrency: 5, maxQueueSize: 50 },
  },
});

const result = await client.get("/users/1").toPromise();

if (result.success) {
  console.log(result.raw.status); // resilient by default, after up to 5 retries
}
```

## Why Vereda?

`fetch` gives you one attempt. Production systems need more:

```
                Without Vereda               With Vereda

Service             │                          │
                    ▼                          ▼
               fetch()                     Vereda
                    │                          │
               ┌────┴────┐                     └── resilient request
               │         │
            try/catch   setTimeout
               │         │
            retry?     AbortController
               │         │
           backoff?    concurrency queue
               │         │
            logging?   ...
```

Vereda handles retries, exponential backoff, per-host bulkhead isolation, circuit breaking, timeouts, and typed results, so you don't have to wire it up yourself.

**What Vereda does not do.** No response caching, no request deduplication, no streaming helpers, no browser support.

## Tickets

Every request returns a **Ticket** — a handle you can await, subscribe to, or cancel while Vereda does the work. This is the core abstraction.

```typescript
const ticket = client.get("/api/data");
```

```
                  ┌─────────────┐
                  │   pending   │
                  └──────┬──────┘
                         │ first attempt (outside the bulkhead)
              ┌──────────┴──────────┐
              │ success             │ failure / busy status
              ▼                     ▼
        ┌───────────┐        ┌─────────────┐
        │   done    │        │   queued    │
        └───────────┘        └──────┬──────┘
                                    │ backoff
                                    ▼
                             ┌─────────────┐
                             │  retrying   │
                             └──────┬──────┘
                                    │ attempt
                          ┌─────────┴─────────┐
                          ▼                   ▼
                      success              exhausted
                          │                   │
                          ▼                   ▼
                       done          MaxRetriesExceededError
```

You can await it, stream its steps, or cancel it mid-flight:

```typescript
// 1. Await the terminal result
const ticket = client.get("/api/data");
const result = await ticket.toPromise();
if (result.success) {
  console.log(result.data);
}
```

```typescript
// 2. Or follow every state change
const ticket = client.get("/api/data");
for await (const update of ticket.subscribe()) {
  // { type: "queued" }
  // { type: "retrying", attempt, delayMs }
  // { type: "done", result }
  // { type: "cancelled" }
}
```

```typescript
// 3. Or cancel mid-flight
const ticket = client.get("/api/data");
ticket.cancel();
```

`toPromise()` never rejects. The result is a discriminated union:

```typescript
type Result<T> =
  | { success: true; data: T; raw: Response }
  | { success: false; error: AppError };
```

**Why tickets instead of promises?** A promise is a single future value. A resilient request has a lifecycle — queued, retrying, done — and you may want to observe or cancel it mid-flight. A ticket gives you that surface while still offering a plain `toPromise()` for code that just wants the answer.

## How it works

```
client.get(url)
      │
      ▼
 first attempt ────── success ──────> ticket done
      │
 failure, timeout, or busy status (e.g. 429)
      │
      ▼
 partition bulkhead ──> backoff ──> retry ──> ... ──> done
      (per host)                             │
                                             └── attempts exhausted ──> MaxRetriesExceededError
```

The first attempt fires immediately, outside the bulkhead. Only requests that need another attempt go through their partition's queue, so retry traffic never starves fresh requests.

With zero configuration:

| Setting | Default |
| --- | --- |
| Global concurrency | 50 in-flight executions across all partitions |
| Per-partition concurrency | 5 |
| Per-partition queue size | 100 waiting retries |
| Retries | 3 retries after the first attempt (4 total executions) |
| Backoff | Exponential: 200ms base, 30s cap, full jitter |
| Timeout | Required — no library default; pass `Infinity` explicitly to opt out of a per-attempt cap |
| Retry-on status codes | `[408, 425, 429, 500, 502, 503, 504]` |
| First-attempt concurrency | Unbounded — the initial attempt bypasses the bulkhead unless `partition.limitFirstAttempts` is set |
| Circuit breaker | Disabled — opt in with `circuitBreaker: { enabled: true }` |

## Quick start

```bash
npm install vereda
```

```typescript
import { HttpClient } from "vereda";

const client = HttpClient.create({
  baseUrl: "https://api.example.com",
  timeout: { attemptMs: 5000 },
});

const result = await client.get("/users/1").toPromise();
if (result.success) {
  const user = await result.raw.json();
} else {
  console.error(result.error.message); // typed error, never a throw
}
```

That's it. Vereda handles retries, backoff, timeouts, and isolation for you. The package ships a prebuilt `dist/` — installing never compiles anything.

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
| Partition queue full | `queue_full` | Never |
| Invalid configuration | `configuration` | Never |

Idempotent means `GET`, `HEAD`, `OPTIONS`, `PUT`, `DELETE`, or `TRACE`. Non-idempotent methods (`POST`, `PATCH`, `CONNECT`) are retried only with `retry: { idempotent: true }` or an `Idempotency-Key` header. A user-supplied `retryWhen` is consulted after this policy and can only veto, never force, a retry. The busy-status list is `retry.retryOnStatus`.

`maxRetries: 0` disables retries entirely — a failed request resolves with its own error, unwrapped.

```typescript
const client = HttpClient.create({
  retry: {
    maxRetries: 5,
    backoff: {
      baseDelayMs: 1000,
      maxDelayMs: 30000,
      jitter: true,
    },
  },
});
```

The default backoff is `200ms * 2^attempt`, capped at 30s, with full jitter applied. Jitter spreads retries out so a fleet of clients doesn't hit a recovering server at the same instant.

You can also supply a custom backoff function:

```typescript
retry: {
  maxRetries: 3,
  backoff: (attempt) => Math.min(100 * 2 ** attempt, 10000),
}
```

`retryWhen` is consulted after every failed attempt, including the first one. Return `false` to surface the error immediately:

```typescript
import { NetworkError } from "vereda";

retry: {
  maxRetries: 5,
  retryWhen: (error, attempt) => {
    if (error instanceof NetworkError) return false;
    return true;
  },
}
```

When all attempts are exhausted, the ticket resolves with a `MaxRetriesExceededError` carrying the attempt count and the last underlying error.

By default only idempotent methods (`GET`, `HEAD`, `OPTIONS`, `PUT`, `DELETE`, `TRACE`) are retried. Non-idempotent methods (`POST`, `PATCH`, `CONNECT`) are not, since blindly retrying them could duplicate a side effect. Opt in with `retry: { idempotent: true }` or by sending an `Idempotency-Key` header. The underlying `defaultRetryPolicy` is exported for wrapping or inspection.

A request `body` may also be supplied as a factory (`() => BodyInit`); the factory is invoked fresh on every attempt so the payload can be replayed across retries. This is required when the body is a `ReadableStream` — passing a bare stream is a `ConfigurationError`. When a stream body is used, `duplex: "half"` is set on the fetch call automatically.

Retries honor a `Retry-After` response header (seconds or HTTP-date), capped at `maxDelayMs`; without one, the configured backoff drives the delay.

### Bulkhead isolation

Every request is assigned to a partition, keyed by host (hostname:port) by default — `http://api.example.com:8080` and `http://api.example.com:9090` land in separate partitions. Each partition owns a concurrency limit plus a waiting queue. A slow or failing host fills its own queue without touching traffic to other hosts.

The concurrency limit and queue govern only **retry traffic** — the initial attempt always fires immediately and is never throttled by the bulkhead.

```typescript
const client = HttpClient.create({
  concurrency: 10,
  partitions: {
    "api.external.com": { concurrency: 2, maxQueueSize: 10 },
    "api.internal.com": { concurrency: 20 },
  },
});
```

You can assign a partition explicitly for priority lanes or host grouping:

```typescript
client.get("/path", { partition: "high-priority" });
```

When a partition's queue is full, the ticket resolves with a `QueueFullError`. That is deliberate backpressure: the alternative is unbounded memory growth.

### Circuit breaker

Opt-in, per-partition. Once a host is clearly failing, stop sending it requests instead of retrying into it. Disabled by default.

```typescript
const client = HttpClient.create({
  timeout: { attemptMs: 5000 },
  circuitBreaker: {
    enabled: true,
    failureThreshold: 5, // consecutive failures that trip it open
    resetTimeoutMs: 30_000, // how long to stay open before a half-open trial
  },
});
```

The breaker is checked before the first attempt and again before every retry — while open, requests to that partition fail immediately with `CircuitOpenError` and no attempt is made. After `resetTimeoutMs`, one trial request is let through (`halfOpenMaxAttempts`); success closes the circuit, another failure reopens it.

Trip on a rolling failure rate instead of consecutive failures:

```typescript
circuitBreaker: {
  enabled: true,
  window: { sizeMs: 60_000, minimumRequests: 20, failureRatePercent: 50 },
}
```

### Timeouts

```typescript
const client = HttpClient.create({
  timeout: {
    attemptMs: 5000,
  },
  retry: {
    retryOnStatus: [429, 503],
  },
});
```

- `attemptMs` — a hard per-attempt timeout. The attempt is aborted and the request joins the retry loop. Required on the client-level `timeout` config — pass `Infinity` to explicitly opt out of a cap. Partition- and request-level `timeout` stay optional and inherit the client default.
- `retryOnStatus` — status codes that mean the server is busy rather than broken. Matching responses are queued for retry without being treated as errors.

Both settings merge per request:

```typescript
client.get("/api/data", {
  timeout: { attemptMs: 10000 },
  retry: { retryOnStatus: [429, 500, 502, 503, 504] },
});
```

### Typed results

Pass a `parse` function to validate and type the response body. `parse` is just `(data: unknown) => T`, and any validator that throws on failure works. A failed parse resolves the ticket with a `ValidationError` and is never retried.

```typescript
const ticket = client.get<User>("/users/1", {
  parse: (data) => data as User, // or your own throwing validator
});

const result = await ticket.toPromise();
if (result.success) {
  result.data.name; // typed: string
}
```

#### Zod adapter (optional)

Zod is an optional peer dependency. Only the `vereda/zod` entry point imports it; the core has zero dependencies. Vereda ships a Zod adapter for it:

```typescript
import { z } from "zod";
import { withZod } from "vereda/zod";

const UserSchema = z.object({
  id: z.number(),
  name: z.string(),
  email: z.string().email(),
});

const ticket = client.get<User>("/users/1", { parse: withZod(UserSchema) });

const result = await ticket.toPromise();
if (result.success) {
  result.data.name; // typed: string
}
```

### Middleware

Middleware wraps every attempt (including retries) in the standard onion shape. Each middleware receives a `RequestContext` — `{ url, method, headers, body, signal, attempt, ticketId, partition }`, where `headers` is a real `Headers` instance — and a `next` function that calls the next middleware (or the actual fetch):

```typescript
import { defaultHeaders, requestLogger } from "vereda/middleware";

client.use(defaultHeaders({ Authorization: "Bearer token123" }));
client.use(requestLogger());

client.use(async (ctx, next) => {
  console.log("Request:", ctx.url, "attempt", ctx.attempt);
  const response = await next(ctx);
  console.log("Response:", response.status);
  return response;
});
```

Middleware can rewrite `ctx.url` before calling `next(ctx)` — whatever URL survives to the innermost middleware is what actually gets fetched. `defaultHeaders()` only sets a header the request doesn't already have; the comparison is case-insensitive, so a request-level `authorization` header always wins over a default `Authorization` one and you never end up sending both.

Middleware receives the same `AbortSignal` the request uses (`ctx.signal`), so it can participate in timeout and cancellation handling — but only if it observes or forwards that signal to the work it performs.

### Lifecycle events

The client emits typed events across all requests, useful for metrics, logging, and alerting. Exactly one of `success`, `failure`, or `cancelled` fires per ticket:

```typescript
client.on("request",   ({ ticketId, url, method, partition }) => {});
client.on("retry",     ({ ticketId, url, attempt, delayMs, error }) => {});
client.on("success",   ({ ticketId, url, attempts, durationMs, queuedMs, statusCode }) => {});
client.on("failure",   ({ ticketId, url, attempts, durationMs, queuedMs, error }) => {});
client.on("cancelled", ({ ticketId, url, attempts, durationMs }) => {});
```

`retry`'s `attempt` is a zero-based retry index (`0` = the first retry, after the initial attempt). `off(event, listener)` removes a listener with the same signature as `on`.

If the circuit breaker is enabled, a partition also fires `circuitOpen`/`circuitClose` independently of any single ticket:

```typescript
client.on("circuitOpen",  ({ partition }) => {});
client.on("circuitClose", ({ partition }) => {});
```

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

### Error handling

Errors are a closed hierarchy under `RequestError`. Every class carries a readonly `kind` string discriminant — `AppError` is the union of all of them:

| Error | `kind` | Meaning | Notable fields |
| --- | --- | --- | --- |
| `NetworkError` | `"network"` | Request failed before a response arrived (DNS, connection reset, etc.) | `cause` |
| `HttpError` | `"http"` | Non-2xx response outside `retry.retryOnStatus` (e.g. `404`) | `statusCode`, `response` |
| `RetryableStatusError` | `"retryable_status"` | Non-2xx response matching `retry.retryOnStatus` (e.g. `503`) | `statusCode`, `response`, `retryAfterMs?` |
| `TimeoutError` | `"timeout"` | Attempt exceeded `timeout.attemptMs` | `url`, `timeoutMs` |
| `DeadlineExceededError` | `"deadline"` | Ticket exceeded `timeout.totalMs` (terminal — not retried) | `url`, `totalMs` |
| `ValidationError` | `"validation"` | Response body failed `parse` (terminal — never retried) | `issues`, `cause` |
| `CancelledError` | `"cancelled"` | Ticket cancelled or signal aborted (terminal) | — |
| `QueueFullError` | `"queue_full"` | Partition's queue was full when a retry tried to enqueue (terminal) | `partition`, `queueSize`, `maxQueueSize` |
| `ConfigurationError` | `"configuration"` | Invalid client/request config, or a body factory that threw (terminal) | `key` |
| `MaxRetriesExceededError` | `"max_retries"` | All retries exhausted (terminal) | `attempts`, `lastError` |

Only `network`, `timeout`, and `retryable_status` are retried by default — see [What gets retried](#what-gets-retried) above. Everything else is terminal: it resolves the ticket on the first attempt that produces it.

```typescript
import { MaxRetriesExceededError, HttpError } from "vereda";

const result = await ticket.toPromise();
if (!result.success) {
  switch (result.error.kind) {
    case "max_retries":
      // result.error is MaxRetriesExceededError; .lastError is the final attempt's error
      break;
    case "http":
      // result.error is HttpError; .statusCode, .response
      break;
    default:
      console.error(result.error.message);
  }
}
```

## Design philosophy

**Fresh traffic comes first.** Retries should never starve new work. The first attempt skips the bulkhead — it exists to throttle *retry* pressure onto struggling hosts, which is where thundering herds come from.

**Backpressure beats unbounded queues.** When a partition is full, fail explicitly rather than consuming infinite memory.

**Cancellation is final.** A cancelled request never enters the retry loop, regardless of timeout or retry configuration.

**Validation failures aren't transient.** A response that fails your `parse` function resolves immediately — retrying would parse the same payload again.

## Documentation

- **[Operations guide](docs/operations.md)** — sizing concurrency and queues, `attemptMs` vs. `totalMs`, reading `partitions()`, wiring a metrics sink, the shutdown sequence, and log redaction.
- **[API reference](https://riosgabriel.github.io/vereda/)** — generated from source via TypeDoc on every push to `main`; every public option documents its default.

## Versioning and support

Vereda follows [Semantic Versioning](https://semver.org/) from `1.0.0` onward: breaking changes land only in a major version, and anything scheduled for removal is deprecated in a minor release first and noted in [CHANGELOG.md](CHANGELOG.md) before it goes. The public surface is exactly what `src/core/index.ts`, `src/middleware/index.ts`, and `src/adapters/zod.ts` export — internals under `src/queue/` and `src/ticket/` are not part of the contract even though they're readable source.

**Node support:** the currently supported line is whatever `engines.node` in `package.json` declares (`>=20` today); CI runs the full suite against Node 20, 22, and 24 on every change, so those three are the versions actually verified. The floor moves only in a major release.

## Development

```bash
git clone https://github.com/riosgabriel/vereda.git
cd vereda
bun install       # bun.lock is the only lockfile
npm test          # vitest run
bun run --bun test # same suite under the Bun runtime (as CI does)
npm run typecheck
npm run build
npm run format
npm run lint
```

Tests are self-contained: integration tests spin up `node:http` servers on ephemeral localhost ports. No network, services, or env vars needed.

## Contributing

New to Vereda? Two on-ramps:

- **Self-guided** — read [ONBOARDING.md](ONBOARDING.md), a tour that follows one request through the library.
- **Interactive** — run the **`guide-me`** skill in your coding harness (Claude Code, OpenCode, etc.). It's bundled in the repo and walks you through the internals interactively.

When you're ready, read [CONTRIBUTING.md](CONTRIBUTING.md) for setup, commands, and the behavioral invariants your change must preserve.

## Why the name?

**Vereda** is Brazilian Portuguese for a narrow trail: a resilient route through terrain. That maps directly to what the library does: give your requests a reliable path through flaky networks, retries, and backpressure. *veh-REH-da.*

## License

MIT
