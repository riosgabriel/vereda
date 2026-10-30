# Glossary

Terms as this codebase uses them. The chapter where each is introduced is in parentheses.

**`AppError`** — The union of Vereda's twelve error classes, defined in `src/core/errors.ts`. Every
failed `Result` carries one. Each has a literal `kind`. (3, 7)

**Attempt** — One execution of `executeRequest`: middleware, `fetch`, body read, `parse`. Attempt 0
is the first; attempt *n* is the *n*th retry. (5, 6)

**`attemptMs`** — The per-attempt timeout, required at client level. `Infinity` means no cap. Also
bounds a handed-off body's read window. (1, 6)

**B-labels (`B1`–`B17`)** — Bugs found in the post-1.0 review, cited in comments, tests and commit
messages. Chapter 11 lists them. (1, 11)

**Backoff** — The delay before a retry: `baseDelayMs × 2^n`, capped at `maxDelayMs`, with full
jitter by default. Built by `buildBackoffFn`. (7)

**Backstop `.catch`** — The `.catch` attached to `_fireFirstAttempt` (in `send`) and to
`runRetryLoop` (in `_scheduleInBulkhead`). It should never run; if it does, it settles the ticket
only if nothing else has. (5)

**Bulkhead** — A per-partition concurrency limit with a bounded wait queue, in
`src/queue/bulkhead.ts`. Applies to retries, and to first attempts when `limitFirstAttempts` is set.
(8)

**Burst** — The token bucket's capacity: how many attempts may go back to back after a quiet spell.
Defaults to one second's worth, at least 1. (8)

**Circuit breaker** — A per-partition state machine (closed, open, half-open) that rejects attempts
with `CircuitOpenError` after enough failures. Opt-in. (9)

**Cleanup** — The per-ticket closure built in `send` that removes the caller-signal listener,
clears the deadline timer, releases the partition holds, and removes the ticket from the in-flight
set. Safe to call more than once. (5)

**Controller (`TicketController`)** — The internal handle that can change a ticket's state:
`markQueued`, `markRetrying`, `markDone`, `abortSignal`. Returned by `createTicket` alongside the
ticket. (4)

**D-labels (`D1`, `D3`, `D4`), R-labels (`R3`, `R6`)** — Early design-decision labels cited in code
comments. No file in the repo defines them. D4 is "first attempts skip the partition slot, global
permit after partition slot"; R6 is `limitFirstAttempts`. (8)

**Deadline (`totalMs`)** — The whole-ticket time limit, counted from the call. On expiry it aborts
the ticket's signal without cancelling, and the ticket fails with `DeadlineExceededError`. (4, 5)

**`defaultPartition`** — Config for every partition not listed in `partitions`. A listed partition
does not inherit from it. (3)

**Deprecation (1.x)** — Behaviour kept working in 1.x but scheduled to change in 2.0 (issue #148): `BulkheadSnapshot.name` (use `partition`); `QueueFullError.partition` set to `"global"` (check `scope`); and a `circuitBreaker` config without `enabled: true` being inert, which 2.0 will switch on. Listed in the changelog's `Deprecated` section. (1, 3)

**`displayUrl`** — The full URL with query values and credentials redacted (unless `redactQuery:
false`). Used in events, logs and error messages. Contrast `fullUrl`, which is fetched. (5, 10)

**`faultyFetch`** — The `@vereda/http/testing` helper that wraps a `fetch` and fails some calls on
purpose (a status, a delay, a network error, a hang), in a seeded, repeatable order. (12)

**Full jitter** — Choosing the whole retry delay uniformly at random between 0 and the capped
exponential value, so clients that failed together don't retry together. (7)

**Generation (half-open)** — A counter bumped each time the breaker goes half-open. A permit
records an outcome only if it was a trial of the current generation. (9)

**Global semaphore** — The client-wide cap on attempts in flight (`ClientConfig.concurrency`,
default 50) with a bounded queue (`maxQueueSize`, default 100). Every attempt takes a permit. (8)

**Handed-off body** — A `Response` body returned to the caller unread (`raw` on a success without
`parse`/`responseType`, or `HttpError.response`). Its read is bounded by a timer armed in the
executor's `finally`. (6)

**Hold (`retain`)** — A ticket's claim on its partition's bulkhead, breaker and retry budget, so the
registries don't evict them while the ticket sleeps between retries. Released by cleanup. (5, 8)

**Idempotent** — Safe to send more than once. GET, HEAD, OPTIONS, PUT and DELETE are; POST and PATCH
are retried only with `retry.idempotent: true`, `retry.idempotencyKey` or an `Idempotency-Key`
header. (7)

**`isBoundedMs`** — The check for "a real, finite timeout". Every timer creation goes through it so
`Infinity` never reaches `setTimeout`. (1)

**`isCancelled` / `isSettled`** — Ticket flags. `isCancelled`: the caller ended it. `isSettled`: it's
over by any path. (4)

**Lifecycle event** — A client-level event (`request`, `retry`, `success`, `failure`, `cancelled`,
`retryBudgetExhausted`, `circuitOpen`, `circuitClose`) emitted through `HttpClient.emit`. (10)

**`limitFirstAttempts`** — Partition option that makes first attempts take a partition slot too. (5,
8)

**`MAX_TIMER_MS`** — 2,147,483,647 ms (about 24.8 days), the longest delay a JavaScript timer can hold; a larger one fires after about 1 ms. `close()` and the `attemptMs`/`totalMs` checks reject values above it; computed waits go through `setLongTimeout` instead. Defined in `src/core/timer.ts`. (5, 11)

**`MetricsSink`** — The three-method interface (`counter`, `histogram`, `gauge`) a client reports
metrics to. Metric names are in `METRICS`. (10)

**Middleware** — A function `(ctx, next) => Promise<Response>` registered with `client.use()`,
composed into an onion around `fetch` for every attempt. The first registered is outermost. (6)

**Never-sent outcome** — An attempt that failed before `fetch` was called (a body factory that
threw). The breaker ignores it. (9)

**Non-failure outcome** — An attempt that reached the host but failed in a way the breaker doesn't
count (a 404, a `ValidationError`). The breaker records it as a success. (9)

**Opt-out (`false`)** — Setting a partition's `rateLimit`, `retryBudget` or `pauseOnRetryAfter` to `false` so it ignores the client-wide one. Leaving the key out inherits it instead; spreading config can't express "none", so `false` is the explicit off switch. (3, 8, 9)

**Partition** — The unit of isolation, by default the URL's host (hostname plus non-default port).
Each has its own bulkhead, breaker, retry budget and rate limiter. (3, 8)

**Partition pause** — A partition's "send nothing before this time", set by a `Retry-After` on a
429 or 503 when `pauseOnRetryAfter` is configured. It lives in `PartitionPause`
(`src/queue/pause.ts`), only moves forward, and is clamped to `maxPauseMs`. (7, 8)

**Permit (circuit breaker)** — The object `tryAcquire()` returns. Exactly one of `success()`,
`failure(err)` or `release()` takes effect; callers always `release()` in a `finally`. (9)

**Pre-aborted request** — A request whose caller signal is already aborted when it's sent. It never calls `fetch` and emits exactly one `cancelled` event and no `request` event. (3, 4)

**Property test** — `test/core/lifecycle-invariants.property.test.ts`, which checks the lifecycle
invariants over randomly generated scenarios with fast-check. (11, 12)

**`queuedMs`** — Total time a ticket spent waiting for tokens, partition slots and global permits,
across all its attempts. Measured, not sampled. (5)

**`QueueFullError.scope`** — `"partition"` or `"global"`: which queue was full, the partition bulkhead's (retries, and first attempts with `limitFirstAttempts`) or the global semaphore's. (3, 8)

**Registry** — A per-type map from partition name to its bulkhead, breaker or budget, created on
demand and pruned when idle past a 60 s TTL. (8)

**`reportCallbackError`** — Where an error thrown by user code (a listener, a hook, the logger, a metrics sink) goes: rethrown on a later tick, so it surfaces as an uncaught error without changing the request's outcome. (4, 10)

**Reservation (token bucket)** — Taking a token even when the bucket is empty, letting the balance
go negative, and waiting exactly until that token would exist. Serves callers in arrival order
without a queue. (8)

**`Result`** — `{ success: true, data, raw } | { success: false, error }`. What `toPromise()`
resolves to; it never rejects. (3)

**Retry budget** — A per-partition cap on retries as a fraction of recent first attempts, with a
per-second floor. Opt-in. (9)

**Retry storm** — Many clients retrying a struggling host at once, multiplying its load just when it can least take it. The retry budget limits it. (9)

**`Retry-After`** — A response header giving seconds or a date to wait. Overrides backoff, without
jitter, capped at `maxDelayMs`. Seconds or any of the three RFC 9110 date forms. With
`pauseOnRetryAfter` it also pauses the whole partition. (7, 8)

**`retryOnStatus`** — The statuses that become a retryable `RetryableStatusError`. Default
`[408, 425, 429, 500, 502, 503, 504]`. (6, 7)

**`retryWhen`** — The caller's predicate, consulted after the default policy, that can veto a retry
but never force one. (7)

**`settleOnAbort`** — The executor helper that makes an awaited promise reject as soon as the
attempt's signal aborts, so an attempt ends even if the transport ignores the signal. (6)

**`setLongTimeout`** — `setTimeout` for delays vereda computes (backoff, a capped `Retry-After`, a token wait): it chains timers of at most `MAX_TIMER_MS`, so a longer wait still lasts its full length. Returns a cancel function. (11)

**Spine** — The path a request takes from `client.get()` to a settled ticket: `send`,
`_fireFirstAttempt`, `runRetryLoop`. (5)

**Terminal event** — One of `success`, `failure`, `cancelled`. Exactly one fires per ticket, and it
matches the `Result`. (5, 11)

**Ticket** — The handle a request returns synchronously. Can be awaited (`toPromise`), observed
(`on`, `subscribe`) and cancelled. (4)

**Token bucket** — The per-partition rate limiter in `src/queue/rate-limiter.ts`. Opt-in via
`rateLimit`. (8)

**Trip** — The breaker moving from closed to open, on consecutive failures or a rolling-window
failure rate. Closing again empties the window (#219). (9)
