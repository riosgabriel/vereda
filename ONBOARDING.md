# Onboarding to Relay

Welcome! This guide walks you through how Relay works by following a single request through the codebase. By the end you'll understand the architecture well enough to fix a bug or add a feature.

**Prerequisites:** Node 18+, basic TypeScript, familiarity with `fetch`.

> If this doc and the code disagree, trust the code and the tests. This doc is curated by hand and can lag.

## Architecture in 30 seconds

Relay is a resilient HTTP client built on Node's global `fetch`. Four ideas carry the whole design:

- **Ticket** — a handle for a request in flight. You get one back synchronously from `client.get()`; you can await it, subscribe to its state changes, or cancel it.
- **Retry** — failed requests are retried with exponential backoff and jitter, up to a configurable limit.
- **Bulkhead** — each host gets its own concurrency limit and waiting queue, so one struggling upstream can't starve the others.
- **Result** — requests never throw. They resolve to a `{ success, data, raw }` or `{ success: false, error }` union with typed errors.

The one flow to understand: **the first attempt fires immediately, outside the bulkhead. Only retries go through the per-host bulkhead.** This keeps fresh requests fast while throttling retry pressure onto struggling hosts.

## The reading path

Follow one request — `client.get("/users/1")` — from call to settled result. Read these stops in order.

### Stop 0 — Get the vocabulary
**Read:** `src/core/types.ts`, `src/core/errors.ts`

Skim, don't study. Everything resolves to a `Result`; errors form a closed hierarchy under `RelayError` (`NetworkError`, `TimeoutError`, `ValidationError`, `CancelledError`, `MaxRetriesExceededError`). This is your reference for the rest of the tour.

### Stop 1 — The entry point
**Read:** `src/core/client.ts` → `HttpClient.request()`

`client.get()` is a thin wrapper around `request()`. `request()` creates a `Ticket`, picks a partition (the hostname), fires the first attempt, and returns the ticket synchronously. Notice that the first attempt runs **outside** the bulkhead.

### Stop 2 — The handle you got back
**Read:** `src/ticket/ticket.ts` → `Ticket`

A state machine: `pending → queued → retrying → done/cancelled`. `toPromise()` never rejects; `subscribe()` and `on()` let you observe state changes; `cancel()` aborts. This is why Relay returns a ticket instead of a plain promise.

### Stop 3 — One attempt
**Read:** `src/queue/executor.ts` → `executeRequest()`

A single attempt: compose middleware around `fetch`, race a timeout if configured, check `queueOnStatus`, treat non-2xx as an error, and `parse` the body if a parser is given. It returns a discriminated union (`ExecuteResult`) so the caller decides what happens next.

### Stop 4 — The fork
**Read:** `src/core/client.ts` → `_fireFirstAttempt()`

The decision logic after the first attempt. A `ValidationError` resolves immediately and is never retried. Otherwise `retryWhen` is consulted (even for attempt 0) and can veto a retry; if not vetoed, the request is queued.

### Stop 5 — The gatekeeper
**Read:** `src/queue/bulkhead.ts` → `Bulkhead`, `BulkheadRegistry`

Each partition gets a concurrency limit plus a waiting queue. `schedule()` rejects when the queue is full — deliberate backpressure. This is what throttles retry traffic per host.

### Stop 6 — The retry loop
**Read:** `src/queue/retry.ts` → `runRetryLoop()`

Where retries actually happen. Each attempt: check cancellation, consult `retryWhen`, back off, and re-run `executeRequest()`. When attempts are exhausted, the ticket resolves with `MaxRetriesExceededError`. It reuses the same executor as the first attempt.

### Stop 7 — The delay
**Read:** `src/core/backoff.ts` → `buildBackoffFn()`

Small and self-contained — a good first file to fully understand. Exponential `base × 2^attempt`, capped, with full jitter to avoid thundering herds.

### Tying it together

The ticket settles with a `Result`, and the client emits `success`/`failure` lifecycle events you can observe with `client.on(...)`.

## Where to go next

| Want to… | Read |
| --- | --- |
| Add or change middleware | `src/middleware/index.ts` (`defaultHeaders`, `requestLogger`) + `composeMiddleware` in `src/queue/executor.ts` |
| Add a schema-validation adapter | `src/adapters/zod.ts` (`withZod`) + the `parse` path in `src/queue/executor.ts` |
| Understand observability | `client.on`/`off`/`emit` in `src/core/client.ts`; `Ticket.subscribe()` in `src/ticket/ticket.ts` |
| See expected behavior | The tests — `test/core/client.integration.test.ts` is the best end-to-end read |
| See the public API surface | `src/core/index.ts` |

Ready to contribute? See [CONTRIBUTING.md](./CONTRIBUTING.md).