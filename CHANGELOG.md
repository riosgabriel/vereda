# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Per-partition circuit breaker (opt-in via `circuitBreaker: { enabled: true }`), mirroring the bulkhead registry: trips on consecutive failures (default) or a rolling failure-rate window, then half-opens after `resetTimeoutMs` to trial recovery. Rejects immediately with the new `CircuitOpenError` — no attempt is made while open (#60).
- Real `queuedMs` on `success`/`failure`/`cancelled` lifecycle events — total time a ticket spent waiting for a bulkhead/global-semaphore permit, summed across all attempts (previously always `0`). New `vereda.global_queue_depth` gauge reports the global concurrency cap's (D1) wait-queue backlog; `vereda.queue_depth` (declared previously but never emitted) now reports real per-partition backlog. See [Wiring a metrics sink](docs/operations.md#wiring-a-metrics-sink) (#72).

- `redactUrl` is exported from `vereda`, for redacting URLs in your own logging the same way the client does. `requestLogger()` accepts `redactQuery` (default `true`).
- `Semaphore.acquire()` and `Bulkhead.run()` accept an `AbortSignal`: a waiter whose signal aborts leaves the queue.

### Changed (breaking)

- `ClientConfig.timeout.attemptMs` is now required. Every other default in the library fails safe when omitted; an omitted per-attempt timeout previously meant "unbounded." Pass `Infinity` explicitly to opt out of a cap. Partition- and request-level `timeout` remain optional and inherit the client-level default (#60).
- Each error class now types `kind` as its literal (`HttpError["kind"]` is `"http"`, not `string`), so `switch (error.kind)` on an `AppError` narrows to the matching class and can be checked for exhaustiveness. A bare `RequestError` is no longer assignable to `AppError`, and comparing `kind` against a string outside the closed set is now a type error. At runtime, an unexpected `RequestError` that isn't one of the library's classes is wrapped in a `NetworkError` (original as `cause`) instead of passing through.
- A non-retryable error (e.g. `HttpError`, `ValidationError`) on the *final* retry attempt is no longer wrapped in `MaxRetriesExceededError`. Every other attempt already resolved this way — a terminal error surfaces raw as soon as it happens — but the last attempt fell through to the retries-exhausted path unconditionally. It now resolves with the raw underlying error, same as a terminal error anywhere else in the loop. Only an exhaustion of genuinely retryable errors still resolves with `MaxRetriesExceededError`. Code that pattern-matches on `result.error` at the end of a retry sequence may need to also handle the raw error type it previously only saw wrapped.
- Bodies of unparsed success responses and `HttpError` responses are now bounded by the attempt's remaining `attemptMs` (capped at `totalMs`), measured from attempt start. Previously, once the ticket resolved with the raw `Response`, its body had no deadline at all — a server that sent headers then stalled the body could hang `raw.json()`/`error.response.text()` forever, past both timeouts. Whichever bound fires rejects that read with Vereda's own `TimeoutError` (`attemptMs` fired first, or was the only bound) or `DeadlineExceededError` (`totalMs` fired first) — not a bare `DOMException` — so it's `instanceof` the right class, `.kind`-narrowable, and its `.url` is redacted like any other error the client builds. Streaming or reading a body later than that needs `timeout: { attemptMs: Infinity }` (and no `totalMs`) on that request, or your own `AbortSignal`.
- Request-level `timeout`/`retry` options are now validated the same as client config. A previously-silently-accepted invalid value (e.g. `timeout: { attemptMs: -5 }`) now resolves the ticket with `ConfigurationError` instead of running the request with broken or undefined behavior.

### Changed

- A response body that isn't valid JSON (when `parse` is set) now resolves with a `ValidationError` and is never retried. Previously it was a `NetworkError`, so it was retried against a server that would give the same answer. A body stream that fails mid-read is still a retriable `NetworkError`.
- `redactQuery` (default `true`) now also redacts userinfo credentials (`https://user:pass@host` → `https://[redacted]@host`) and the URLs embedded in `TimeoutError`/`DeadlineExceededError` (`message` and `url`). The bundled `requestLogger()` middleware now redacts by default.
- The circuit breaker now counts errors it doesn't classify as failures (e.g. a 404 or a `ValidationError`) as successes: the host answered. A half-open trial answered with a 404 closes the circuit; while closed, such a response resets the consecutive-failure count and counts as a non-failure in the rolling window. Previously these responses were ignored entirely.

### Fixed

- **With `baseUrl` set, retries never reached the server.** Every retry fetched the caller's bare relative path (e.g. `/users`) instead of `baseUrl` + path, failed on the client with a `NetworkError`, and burned the full retry budget.
- A partition-level `timeout.totalMs` was ignored unless the partition was named explicitly with `options.partition`, so it never applied to the default host-derived partitions.
- A first attempt cut off by `timeout.totalMs` emitted a `cancelled` lifecycle event while the ticket resolved with `DeadlineExceededError`. It now emits `failure`, as the retry path already did.
- The query-redacted URL leaked unredacted into the `failure` event when the retry policy or `retryWhen` rejected a first-attempt error.
- `close({ drain: true })` with a missing or non-positive `timeoutMs` marked the client closed before throwing, so a corrected second `close()` returned immediately without draining. It now rejects and leaves the client open. A `close()` called while a drain is in progress now waits for that drain instead of resolving immediately.
- A ticket cancelled (or past its `totalMs`) while waiting for a partition slot or a global concurrency permit kept its place in the queue until it reached the front, so live requests could get a `QueueFullError`. Waiters now leave the queue as soon as their ticket aborts.
- The circuit breaker could get stuck half-open indefinitely. A half-open trial that ended in a non-failure error (e.g. a 404 or a failed `parse`), was cancelled, hit its deadline, was vetoed by `retryWhen`, or got a `QueueFullError` never gave its trial slot back, so every later request to that partition failed with `CircuitOpenError` until the partition sat idle for 60s. Also, a request admitted while the circuit was closed that finished during a later half-open period could close the circuit on behalf of trials still in flight.
- A `ticket.on("done" | "update" | "error")` listener that threw left `ticket.toPromise()` unresolved forever, and stopped the remaining listeners from running.
- A client lifecycle listener or `metrics` sink that threw turned a successful request into a `NetworkError` failure (and emitted a spurious `failure` event). Listener and sink errors are now isolated from the request and rethrown on a microtask.
- `Bulkhead.run()` leaked a phantom running-slot when the global semaphore rejected with `QueueFullError` (the global concurrency cap was saturated mid-retry), permanently degrading that partition's effective concurrency by one per occurrence (#72).
- A `QueueFullError` mid-retry discarded the `queuedMs` already accumulated by retries that had run before it, undercounting exactly the signal `queuedMs` exists to report (#72).
- `cancel()`ing a ticket while it was mid-retry and about to hit a `QueueFullError`, or while a first attempt's global-permit acquire was still pending, could still emit a spurious `failure` event afterward — violating "exactly one of success/failure/cancelled per ticket" (#77).
- `Bulkhead.run()` released a task's semaphore permit *after* draining the next queued waiter instead of before, so that waiter's own `semaphore.acquire()` could spuriously reject with `QueueFullError` even though a permit was about to free (#77).
- A `QueueFullError` from a saturated global semaphore during a retry reported one more `attempts` than actually ran (the rejected call never dispatched the request), and dropped whatever time that same attempt had already spent waiting in its own partition's queue before hitting the global cap (#77).
- A user-supplied `retryWhen` was consulted twice for the first failed attempt — once client-side before queuing, once again at the top of the retry loop — so it saw attempt `0` twice and could veto or count it redundantly. `retryWhen` is now called exactly once per failed attempt that could still be retried.
- With `maxRetries: 0`, `retryWhen` was still consulted once for the first (and only) attempt's failure, even though no retry was possible. It's now never called — the failed attempt resolves with its own error, unwrapped, as before.
- The circuit breaker counted an attempt that never reached the host (a body factory that threw before the request was dispatched) as a success — it reset the consecutive-failure count, counted as a non-failure in the rolling window, and could close a half-open trial, all without the host ever being contacted. Such an outcome is now ignored entirely: no change to the failure count, the rolling window, or open/closed state, and in half-open it frees the trial slot without deciding it.

## [1.0.0] - 2026-09-07

Vereda's first release published to npm. Before this, there was no published
package: the project (then named `relay`) was consumed by pointing a
dependency straight at a GitHub ref, where a `prepare` script compiled
`dist/` on install and there were no semver guarantees. The entries below
summarize the real, user-visible changes accumulated across that pre-1.0
development — most relevant if you were depending on a GitHub commit/branch
of this project before today.

### Added

- Structured error hierarchy: every failure is a `RequestError` subclass with
  a discriminated `kind` — `NetworkError` (`network`), `HttpError` (`http`),
  `RetryableStatusError` (`retryable_status`), `TimeoutError` (`timeout`),
  `DeadlineExceededError` (`deadline`), `ValidationError` (`validation`),
  `CancelledError` (`cancelled`), `QueueFullError` (`queue_full`),
  `ConfigurationError` (`configuration`), `MaxRetriesExceededError`
  (`max_retries`). `ticket.toPromise()` never rejects — failures come back as
  a `Result` union over this hierarchy (#29).
- `retryWhen` predicate, consulted after **every** attempt including attempt
  0; it can only veto a retry the default policy would otherwise allow, never
  force one (#32, #33).
- `Retry-After` (seconds or HTTP-date) is honored and capped at
  `backoff.maxDelayMs` instead of always falling back to configured backoff.
- Per-host bulkhead partitions (`partitions` config) with per-partition
  `concurrency` / `maxQueueSize` / `retry` / `timeout` overrides. The first
  attempt always skips the bulkhead; only retries are throttled.
- Graceful shutdown: `client.close({ drain, timeoutMs })` waits for in-flight
  tickets before cancelling the rest; new requests after `close()` throw
  `ConfigurationError("client closed")` (#33).
- Lifecycle events (`request`, `retry`, `success`, `failure`, `cancelled`) via
  `client.on(...)`, enriched with `attempts`, `durationMs`, `queuedMs`, and a
  pluggable `MetricsSink` (`counter`/`histogram`/`gauge`) driven by the same
  events (#44).
- Structured logging with automatic query-string redaction
  (`ClientConfig.redactQuery`, default `true`) so secrets in URLs don't leak
  into logs or lifecycle events (#44).
- Injectable `fetch` (`ClientConfig.fetch`) for tests and custom transports,
  threaded through every attempt including retries (#44).
- Middleware onion model (`client.use(...)`), with `defaultHeaders()` and
  `requestLogger()` helpers shipped from the `vereda/middleware` entry point.
- `withZod()` response-validation adapter shipped from the optional
  `vereda/zod` entry point (zod stays an optional peer dependency; only this
  module imports it).
- `HEAD` / `OPTIONS` / `PUT` / `PATCH` / `DELETE` convenience methods
  alongside `get`/`post`, and a `json<T>()` identity parse helper — the API
  freeze that closes out the pre-1.0 surface.
- Replayable request bodies via a factory (`body: () => BodyInit`), invoked
  fresh per attempt; a raw `ReadableStream` body is a `ConfigurationError`
  instead of silently replaying an already-consumed stream (#33).
- `publint` and `@arethetypeswrong/cli` verify the published package shape in
  CI; `dist/` ships alongside `README.md` and `LICENSE`.

### Changed (breaking, relative to pre-1.0 GitHub installs)

- Project renamed `relay` → `vereda`; the public base error class renamed
  `RelayError` → `RequestError` (subclass names — `NetworkError`,
  `TimeoutError`, `ValidationError`, `CancelledError`,
  `MaxRetriesExceededError` — were unchanged) (#9).
- `RetryConfig.maxAttempts` → `maxRetries`, and it now counts **retries
  only**: `maxRetries: 3` means 1 first attempt + 3 retries = 4 total server
  hits, whereas `maxAttempts: 3` previously meant 3 total hits.
  `MaxRetriesExceededError.attempts` likewise now reports total server hits
  rather than the retry count, and the `retry` lifecycle event's attempt
  index is zero-based (0 = first retry) (#27).
- Default retry policy is now conservative instead of broad: only
  `network` / `timeout` / `retryable_status` errors on idempotent methods are
  retried by default; non-idempotent methods (e.g. `POST`) need explicit
  `retry.idempotent: true` or an `Idempotency-Key` header to opt in (#33).
- `TriggerConfig` and `queueOnStatus` replaced by `TimeoutConfig`
  (`timeout.attemptMs`, `timeout.totalMs`) and `retry.retryOnStatus`
  (default `[408, 425, 429, 500, 502, 503, 504]`) (#32).
- Error identity checks should use `instanceof` — `result.error.constructor
  .name === "ValidationError"`-style checks are no longer the supported
  pattern now that errors carry a real class hierarchy (#27).
- Ticket internal state mutators are no longer reachable from consumer code
  (there is no public `ticket._markDone()` etc.); `createTicket()` returns a
  `{ ticket, controller }` pair for the rare case of driving a ticket
  directly — everyday consumers only ever see the public `Ticket` API (#27).
- Development tooling moved from npm to Bun (`bun.lock` is the lockfile) and
  from ESLint/Prettier to Biome; none of this affects how the package is
  consumed, only how it's built and linted.

### Removed

- The `prepare` script (`tsc && husky`) that compiled `dist/` on install is
  gone. Pre-1.0, this package was installed straight from a GitHub ref and
  `prepare` was load-bearing for that. As of 1.0.0 the package ships a
  prebuilt `dist/` on npm, so nothing compiles on install; the local
  git-hook setup for contributors moved to a one-time `npx husky` (see
  CONTRIBUTING.md).
- Top-level `main` / `types` fields, superseded by the `exports` map (`.`,
  `./middleware`, `./zod`), which has been the actual entry-point source of
  truth since before 1.0.0.

[Unreleased]: https://github.com/riosgabriel/vereda/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/riosgabriel/vereda/releases/tag/v1.0.0
