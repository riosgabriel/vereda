<p align="center">
  <img src="assets/logo.png" alt="Vereda" width="200" />
</p>

<h1 align="center">Vereda</h1>

<h3 align="center">Make <code>fetch</code> resilient.</h3>

<p align="center">
  Retries · Backoff · Bulkheads · Timeouts · Typed Results
</p>

<p align="center">
  <a href="https://github.com/riosgabriel/vereda/actions/workflows/ci.yml"><img src="https://github.com/riosgabriel/vereda/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="https://github.com/riosgabriel/vereda/blob/main/LICENSE"><img src="https://img.shields.io/github/license/riosgabriel/vereda" alt="License" /></a>
  <a href="https://github.com/riosgabriel/vereda"><img src="https://img.shields.io/github/stars/riosgabriel/vereda?style=social" alt="GitHub stars" /></a>
  <a href="https://nodejs.org/en/about/previous-releases"><img src="https://img.shields.io/badge/node-18%2B-green" alt="Node 18+" /></a>
  <a href="https://github.com/riosgabriel/vereda"><img src="https://img.shields.io/badge/ESM-only-blue" alt="ESM only" /></a>
  <a href="https://github.com/riosgabriel/vereda"><img src="https://img.shields.io/badge/TypeScript-6.0-blue" alt="TypeScript" /></a>
</p>

```typescript
import { HttpClient } from "vereda";

const client = HttpClient.create({
  retry: { maxAttempts: 5 },
  trigger: { timeoutMs: 5_000, queueOnStatus: [429, 503] },
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

Vereda handles retries, exponential backoff, per-host bulkhead isolation, timeouts, and typed results, so you don't have to wire it up yourself.

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
| Global concurrency | 10 in-flight retries across all partitions |
| Per-partition concurrency | 5 |
| Per-partition queue size | 100 waiting retries |
| Retries | 3 retries after the first attempt (4 total executions) |
| Backoff | Exponential: 200ms base, 30s cap, full jitter |
| Timeout | None |
| Queue-on status codes | None (all non-2xx responses are retried as errors) |
| First-attempt concurrency | Unbounded — the initial attempt bypasses the bulkhead |

## Quick start

```bash
npm install github:riosgabriel/vereda
```

```typescript
import { HttpClient } from "vereda";

const client = HttpClient.create({ baseUrl: "https://api.example.com" });

const result = await client.get("/users/1").toPromise();
if (result.success) {
  const user = await result.raw.json();
} else {
  console.error(result.error.message); // typed error, never a throw
}
```

That's it. Vereda handles retries, backoff, timeouts, and isolation for you.

Installing from GitHub runs the build via the `prepare` script, so `dist/` is ready as soon as installation finishes.

## Features

### Retries and backoff

Configure retries globally or per request. Per-request settings override global ones.

> **Note:** only global and per-request `retry`/`trigger` are applied today. A partition's `concurrency` and `maxQueueSize` take effect, but its `trigger` and `retry` are currently ignored.

```typescript
const client = HttpClient.create({
  retry: {
    maxAttempts: 5,
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
  maxAttempts: 3,
  backoff: (attempt) => Math.min(100 * 2 ** attempt, 10000),
}
```

`retryWhen` is consulted after every failed attempt, including the first one. Return `false` to surface the error immediately:

```typescript
import { NetworkError } from "vereda";

retry: {
  maxAttempts: 5,
  retryWhen: (error, attempt) => {
    if (error instanceof NetworkError && error.statusCode === 500) return false;
    return true;
  },
}
```

> **⚠️ Retries still apply to non-idempotent methods.** By default Vereda retries network/connection failures and transient statuses (`408`, `429`, `500`, `502`, `503`, `504`), and it retries `POST`, `PUT`, `PATCH`, and `DELETE` exactly like `GET`. A timeout or network error does not prove the server didn't process the request, so only enable automatic retries for operations that are safe to repeat, or constrain them further with a custom `retryWhen`.

When all attempts are exhausted, the ticket resolves with a `MaxRetriesExceededError` carrying the attempt count and the last underlying error.

### Bulkhead isolation

Every request is assigned to a partition, keyed by hostname by default. Each partition owns a concurrency limit plus a waiting queue. A slow or failing host fills its own queue without touching traffic to other hosts.

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

When a partition's queue is full, the ticket resolves with a `NetworkError`. That is deliberate backpressure: the alternative is unbounded memory growth.

### Timeouts

```typescript
const client = HttpClient.create({
  trigger: {
    timeoutMs: 5000,
    queueOnStatus: [429, 503],
  },
});
```

- `timeoutMs` — a hard per-attempt timeout. The attempt is aborted and the request joins the retry loop.
- `queueOnStatus` — status codes that mean the server is busy rather than broken. Matching responses are queued for retry without being treated as errors.

> **Caveats.** A response matched by `queueOnStatus` surfaces to your handler as a `RetryableStatusError` carrying the original `statusCode` (no longer a `TimeoutError`). Vereda does not yet honor the `Retry-After` header; backoff is driven solely by `baseDelayMs`, `maxDelayMs`, and `jitter`.

Both settings merge per request:

```typescript
client.get("/api/data", {
  trigger: { timeoutMs: 10000, queueOnStatus: [429, 500, 502, 503, 504] },
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

Middleware wraps every attempt (including retries) in the standard onion shape:

```typescript
import { defaultHeaders, requestLogger } from "vereda/middleware";

client.use(defaultHeaders({ Authorization: "Bearer token123" }));
client.use(requestLogger());

client.use(async (options, next) => {
  console.log("Request:", options.url);
  const response = await next(options);
  console.log("Response:", response.status);
  return response;
});
```

Middleware receives the same `AbortSignal` the request uses, so it can participate in timeout and cancellation handling — but only if it observes or forwards that signal to the work it performs.

### Lifecycle events

The client emits typed events across all requests, useful for metrics, logging, and alerting:

```typescript
client.on("request", ({ ticketId, url, method }) => {});
client.on("retry",   ({ ticketId, url, attempt, delayMs }) => {});
client.on("success", ({ ticketId, url, attempt }) => {});
client.on("failure", ({ ticketId, url, error }) => {});
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

Errors are a closed hierarchy under `RequestError`:

| Error | Meaning | Notable fields |
| --- | --- | --- |
| `NetworkError` | Network failure or non-2xx response | `statusCode`, `response`, `cause` |
| `TimeoutError` | Attempt exceeded `timeoutMs` | `url`, `timeoutMs` |
| `RetryableStatusError` | Busy status matched by `queueOnStatus` (e.g. 429, 503) | `statusCode`, `response` |
| `ValidationError` | Response body failed `parse` (never retried) | `issues` |
| `CancelledError` | Ticket cancelled or signal aborted | — |
| `MaxRetriesExceededError` | All attempts exhausted | `attempts`, `lastError` |

```typescript
import { MaxRetriesExceededError, NetworkError } from "vereda";

const result = await ticket.toPromise();
if (!result.success) {
  if (result.error instanceof MaxRetriesExceededError) {
    // result.error.lastError is the underlying error from the final attempt
  } else if (result.error instanceof NetworkError) {
    // result.error.statusCode, result.error.response
  }
}
```

## Design philosophy

**Fresh traffic comes first.** Retries should never starve new work. The first attempt skips the bulkhead — it exists to throttle *retry* pressure onto struggling hosts, which is where thundering herds come from.

**Backpressure beats unbounded queues.** When a partition is full, fail explicitly rather than consuming infinite memory.

**Cancellation is final.** A cancelled request never enters the retry loop, regardless of timeout or retry configuration.

**Validation failures aren't transient.** A response that fails your `parse` function resolves immediately — retrying would parse the same payload again.

## Status

> **⚠️ Early stage.** Vereda is experimental software. The API is small, tested (40 passing tests), and MIT licensed, but it has not been hardened in production yet. Pin the version you depend on.

## Development

```bash
git clone https://github.com/riosgabriel/vereda.git
cd vereda
npm install
npm test          # 40 tests (vitest)
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
