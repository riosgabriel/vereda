# Vereda 1.0.0 implementation plan

Companion to `REVIEW.md` (findings #1–#25, recommendations R/O/A/P/Q/D). This file is written to be handed to an implementer — human or model — as the single source of context. It makes the design decisions up front so they are not re-litigated per task, then lists phases of small, independently mergeable tasks with acceptance criteria.

**Working rules for whoever executes this**

1. Read `AGENTS.md` and `CONTRIBUTING.md` first; their gotchas still apply (`.js` import extensions, zod only in `src/adapters/zod.ts`, tests are self-contained with `node:http`).
2. One PR per task (or per tightly coupled task group as marked). Every PR: `npx tsc --noEmit`, `npx eslint .`, `npx prettier --check .`, `npx vitest run` all green. Run binaries via `npx` until Task 0.2 lands (pnpm scripts are broken locally by `pnpm-workspace.yaml`).
3. Each task lists **Acceptance**: tests that must exist and pass. Write the test first when the task fixes a bug — the test should fail on `main` before the fix.
4. Do not widen scope inside a task. If a task reveals a new problem, note it under "Discovered" at the bottom of this file and continue.
5. Anything in **Decisions** is settled. If a decision turns out to be wrong, stop and raise it rather than silently choosing differently.
6. Update docs in the same PR as the behavior change (README, AGENTS.md invariants, ONBOARDING.md if the request flow changed). `REVIEW.md` is historical; do not edit it — tick items off here instead.

---

## Target: what 1.0.0 means

A Node ≥ 20, ESM-only, zero-runtime-dependency resilient `fetch` wrapper that:

- never rejects from `toPromise()`; every failure is a typed `Result` with a discriminated `AppError`;
- retries only what is safe to retry by default, and says exactly what that is;
- bounds every request in time (`totalTimeoutMs`) and in resources (per-partition and global concurrency, bounded queues, no listener/socket leaks);
- is observable (one terminal event per ticket with timings, partition snapshots, metrics sink);
- can be shut down cleanly;
- is published to npm with a frozen public API, generated API docs and a changelog.

---

## Decisions (settled — implement exactly this)

### D1. Naming and defaults

| Concept | Name | Default | Replaces |
| --- | --- | --- | --- |
| Retries after the first attempt | `retry.maxRetries` | `3` | `maxAttempts` (#8). `MaxRetriesExceededError.attempts` = total executions = `maxRetries + 1`. |
| Per-attempt timeout | `timeout.attemptMs` | `undefined` (none) | `trigger.timeoutMs` |
| Whole-ticket deadline | `timeout.totalMs` | `undefined` (none) | new (R3) |
| Busy statuses | `retry.retryOnStatus` | `[408, 425, 429, 500, 502, 503, 504]` | `trigger.queueOnStatus` (#4, #22). `trigger` namespace is removed. |
| Retry non-idempotent methods | `retry.idempotent` (per request) | `false` → POST/PATCH/CONNECT not retried unless `true` or an `Idempotency-Key` header is present | new (#22) |
| Global concurrency cap | `concurrency` | `50` | same name, now a real cross-partition semaphore (#2) |
| Per-partition defaults | `defaultPartition: PartitionConfig` | `{ concurrency: 5, maxQueueSize: 100 }` | the implicit spread (#2) |
| Partition key | `origin` (`scheme://host:port`) | — | `hostname` (#24). `partition` option still overrides. |
| Body | `body: BodyInit \| (() => BodyInit)` | — | `ReadableStream` without factory → `ConfigurationError` (#22, A4) |

Backoff (`retry.backoff`) keeps its shape: `BackoffFn | { baseDelayMs, maxDelayMs, jitter }`, defaults `200 / 30_000 / true`.

`PartitionConfig` gains `retry` and `timeout` **and they are honored** (#23) with merge order global → partition → request (shallow per namespace).

### D2. Error model (A1)

Every error class gets a readonly string `kind`. `AppError` is the union of these classes; `RequestError` remains the base class.

| Class | `kind` | Fields | Retriable by default |
| --- | --- | --- | --- |
| `NetworkError` | `"network"` | `cause` | yes |
| `HttpError` | `"http"` | `statusCode`, `response` | no (4xx) — 5xx are covered by `RetryableStatusError` |
| `RetryableStatusError` | `"retryable_status"` | `statusCode`, `response`, `retryAfterMs?` | yes |
| `TimeoutError` | `"timeout"` | `url`, `timeoutMs` | yes |
| `DeadlineExceededError` | `"deadline"` | `url`, `totalMs` | terminal |
| `ValidationError` | `"validation"` | `issues`, `cause` | never |
| `CancelledError` | `"cancelled"` | — | terminal |
| `QueueFullError` | `"queue_full"` | `partition`, `queueSize`, `maxQueueSize` | terminal |
| `ConfigurationError` | `"configuration"` | `key` | terminal (thrown from `create()`, resolved as Result from `request()`) |
| `MaxRetriesExceededError` | `"max_retries"` | `attempts`, `lastError` | terminal |

`NetworkError` no longer carries `statusCode`/`response`; non-2xx responses become `HttpError` or `RetryableStatusError`. Which statuses are "retryable" is exactly `retry.retryOnStatus`.

### D3. Retry policy (R2)

An attempt is retried iff **all** hold:

1. attempts so far < `maxRetries + 1`;
2. error `kind` ∈ {`network`, `timeout`, `retryable_status`};
3. method is idempotent (`GET HEAD OPTIONS PUT DELETE TRACE`) **or** `retry.idempotent === true` **or** request has an `Idempotency-Key` header;
4. `retryWhen(error, attempt)` (if provided) returns `true`;
5. the ticket is not cancelled and the total deadline has not passed.

Exported as `defaultRetryPolicy` (a `retryWhen`-shaped function) so users can wrap it. Delay for a retry = `retryAfterMs` if present on a `RetryableStatusError` (capped at `maxDelayMs`), else `backoffFn(retryIndex)` where `retryIndex` starts at `0` for the first retry (#6).

### D4. Scheduling (#5)

Each **attempt** (not the whole loop) is a bulkhead task. The retry loop lives outside the bulkhead: `sleep(delay)` → `bulkhead.run(() => executeRequest(...))` → evaluate. Backoff timers are `unref()`ed. The first attempt still bypasses the bulkhead unless `partition.limitFirstAttempts === true` (R6, off by default). A global `Semaphore(concurrency)` is acquired inside `Bulkhead.run` after the per-partition slot.

### D5. Events (O1)

`LifecycleEventMap` becomes:

```ts
request:   { ticketId, url, method, partition }
retry:     { ticketId, url, attempt, delayMs, error }
success:   { ticketId, url, attempts, durationMs, queuedMs, statusCode }
failure:   { ticketId, url, attempts, durationMs, queuedMs, error }
cancelled: { ticketId, url, attempts, durationMs }
```

Exactly one of `success | failure | cancelled` per ticket. `Ticket` updates gain `attempt` on `retrying` (already) and `result` on `done` (already); `queued` gains `partition`.

### D6. Middleware (A2)

```ts
interface RequestContext { url: string; method: string; headers: Headers; body?: BodyInit; signal: AbortSignal; attempt: number; ticketId: string; partition: string }
type MiddlewareFn = (ctx: RequestContext, next: (ctx: RequestContext) => Promise<Response>) => Promise<Response>
```

`headers` is a real `Headers` (case-insensitive). `defaultHeaders` sets only when absent. Public options accept `HeadersInit`.

### D7. Public surface

Exports from `vereda`: `HttpClient`, `Ticket`, all error classes, `defaultRetryPolicy`, `json` parse helper, and types. `Ticket` internals move to a `TicketController` returned by an internal factory; `Ticket` exposes only `id`, `status`, `signal`, `isCancelled`, `on/off`, `cancel`, `toPromise`, `subscribe`. Generic: `request(url)` → `Ticket<undefined>`; `request(url, { parse })` → `Ticket<T>`.

`HttpClient` gains: `partitions(): PartitionSnapshot[]`, `close(opts?)`, constructor options `fetch`, `metrics`, `redactQuery` (default `true`).

### D8. Tooling

Package manager: **npm** (matches README, CI and AGENTS.md). Delete `pnpm-lock.yaml` and `pnpm-workspace.yaml`; commit `package-lock.json`; CI uses `npm ci`. Node matrix `20, 22, 24`; `engines.node >= 20`.

---

## Phase 0 — Unblock (½ day)

### 0.1 README hero example and doc drift — #1 (docs part), #17, D1-docs
- **Files:** `README.md`, `AGENTS.md`, `GOOD_FIRST_ISSUES.md`, `CONTRIBUTING.md`
- **Change:** add `baseUrl` to the hero example; fix defaults table to match code *today* (per-partition 10); remove stale "36/30 tests" sentences; drop the `.claude/skills/` reference or add the symlink to git; remove GOOD_FIRST_ISSUES #1 (obsolete).
- **Acceptance:** `grep -n "36 tests\|30 tests" *.md` → none.

### 0.2 Package manager cleanup — #14, #15, P5, D8
- **Files:** delete `pnpm-lock.yaml`, `pnpm-workspace.yaml`; add `package-lock.json`; `.gitignore` (stop ignoring `package-lock.json`); `.github/workflows/ci.yml` (`npm ci`, add `npm run lint`, `npm run format:check`); `.github/dependabot.yml` unchanged.
- **Acceptance:** `npm ci && npm test && npm run lint && npm run format:check` green locally; CI green.

### 0.3 Relative-URL crash — #1 (code part)
- **Files:** `src/core/client.ts`
- **Change:** move URL/partition resolution inside the async path; on `TypeError` resolve the ticket with `ConfigurationError` (temporarily `NetworkError` until Phase 2 lands the class).
- **Acceptance:** test `client.get("/relative")` with no `baseUrl` returns a ticket whose result is `success:false` and never throws.

---

## Phase 1 — Retry loop correctness (1 day)

Tasks 1.1–1.4 touch `src/queue/retry.ts` and `src/core/client.ts`; land as one PR or in order.

### 1.1 Emit the `retry` lifecycle event — #3
- **Change:** `runRetryLoop` accepts `onRetry(attempt, delayMs, error)`; client wires it to `emit("retry", …)`.
- **Acceptance:** integration test: server returns 503 ×N, `client.on("retry")` fires exactly N−1 times with increasing `attempt`.

### 1.2 First retry gets backoff and a `retrying` update — #6
- **Change:** apply `backoffFn(retryIndex)` and `_markRetrying` on every loop iteration; `retryIndex = 0` for the first retry.
- **Acceptance:** with `maxRetries: 1, baseDelayMs: 50, jitter: false`, second server hit arrives ≥ 45 ms after the first; ticket updates are `queued, retrying, done`.

### 1.3 Rename `maxAttempts` → `maxRetries`; fix `attempts` count — #8, D1
- **Change:** `RetryConfig.maxRetries`; `MaxRetriesExceededError(attempts = executions)`; message "failed after N attempts" where N = server hits.
- **Acceptance:** `maxRetries: 3` → server sees 4 requests and `error.attempts === 4`. `maxRetries: 0` → exactly 1 request, error is the underlying error (not `MaxRetriesExceededError`).

### 1.4 `instanceof` instead of `constructor.name` — #16
- **Acceptance:** existing ValidationError test passes; no `constructor.name` in `src/`.

### 1.5 Hide ticket mutators — #25, D7
- **Files:** `src/ticket/ticket.ts`, `src/core/client.ts`, `src/core/index.ts`, `test/ticket/ticket.test.ts`
- **Change:** `createTicket<T>(id): { ticket, controller }`; controller has `markQueued/markRetrying/markDone`; `Ticket` has no `_` methods. Fix `off()` overloads (#18).
- **Acceptance:** `tsc` fails on `ticket._markDone` from outside; ticket tests rewritten against the controller; `off()` accepts the same listener type as `on()`.

---

## Phase 2 — Error model (1 day)

### 2.1 Add `kind` and new error classes — A1, D2, #4, #12, #23
- **Files:** `src/core/errors.ts`, `src/core/index.ts`
- **Change:** add `kind` to every class; add `HttpError`, `RetryableStatusError`, `DeadlineExceededError`, `QueueFullError`, `ConfigurationError`; remove `statusCode`/`response` from `NetworkError`.
- **Acceptance:** unit test asserting `new X().kind` for every class and that `AppError["kind"]` is the exhaustive union (a `switch` with `never` default compiles).

### 2.2 Executor returns typed status errors — #4, #20
- **Files:** `src/queue/executor.ts`
- **Change:** `ExecuteResult` loses `queued_status`; non-2xx → `{ kind: "error", error: RetryableStatusError | HttpError }` based on `retryOnStatus`; parse `Retry-After` (seconds or HTTP-date) into `retryAfterMs`; call `response.body?.cancel()` on any response whose body will not be read by the library (retryable statuses). `HttpError.response` is left intact for the caller.
- **Acceptance:** 429 with `Retry-After: 2` → `RetryableStatusError { statusCode: 429, retryAfterMs: 2000 }`; 404 → `HttpError`, not retried; after N 503s the server's open-connection count equals the keep-alive pool size, not N.

### 2.3 Queue-full as `QueueFullError` — #12
- **Files:** `src/queue/bulkhead.ts`, `src/core/client.ts`
- **Acceptance:** integration test with `maxQueueSize: 1, concurrency: 1` and 3 failing requests → third ticket resolves with `QueueFullError { partition, queueSize: 1, maxQueueSize: 1 }`.

### 2.4 Config validation — #23
- **Files:** new `src/core/validate.ts`, `src/core/client.ts`
- **Change:** `HttpClient.create()` throws `ConfigurationError` for: non-integer or negative `concurrency`, `maxQueueSize < 1`, `maxRetries < 0`, `timeout.*Ms <= 0`, `baseDelayMs > maxDelayMs`, unknown keys in `partitions.*`. Same validator for per-request options (resolved into the ticket, not thrown).
- **Acceptance:** table-driven test, one row per rule.

---

## Phase 3 — Safe defaults and policy (1–2 days)

### 3.1 `retry.retryOnStatus`, remove `trigger` — D1, #22
- **Files:** `src/core/types.ts`, `src/core/client.ts`, `src/queue/executor.ts`, README
- **Change:** `trigger.queueOnStatus` → `retry.retryOnStatus` with the D1 default; `trigger.timeoutMs` → `timeout.attemptMs`.
- **Acceptance:** default client: 500 → retried, 404 → not; typecheck rejects `trigger`.

### 3.2 `defaultRetryPolicy` and idempotency gate — D3, #22
- **Files:** new `src/queue/policy.ts`, `src/queue/retry.ts`, `src/core/index.ts`
- **Change:** implement D3 rules 2–3 as `defaultRetryPolicy(error, attempt, ctx)`; user `retryWhen` is consulted after it (rule 4). Add `retry.idempotent`.
- **Acceptance:** POST 500 → 1 request; POST 500 with `idempotent: true` → 4; POST 500 with `Idempotency-Key` header → 4; GET 500 → 4; `retryWhen: () => false` → 1.

### 3.3 Replayable bodies — A4, #22
- **Files:** `src/core/types.ts`, `src/queue/executor.ts`, `src/core/validate.ts`
- **Change:** `body: BodyInit | (() => BodyInit)`; factory invoked per attempt; `ReadableStream` without factory → `ConfigurationError`; set `duplex: "half"` when a stream is supplied via factory.
- **Acceptance:** POST with `body: () => new ReadableStream(...)` and `idempotent: true`, server fails first then succeeds → second request carries the full payload.

### 3.4 Honor `Retry-After` — R1
- **Files:** `src/queue/retry.ts`
- **Acceptance:** 429 `Retry-After: 1` with `baseDelayMs: 10` → second hit ≥ 950 ms later; `Retry-After: 120` with `maxDelayMs: 500` → capped at ~500 ms.

### 3.5 "What gets retried" table in README — D2
- **Acceptance:** README section exists; a test (`test/docs/retry-table.test.ts`) asserts the default `retryOnStatus` list printed in the README equals the exported default.

### 3.6 Behavioral matrix test — Q4
- **Files:** new `test/core/retry-matrix.test.ts`
- **Change:** `it.each` over method × {network error, 408, 429, 500, 404, validation} × idempotent flag, asserting expected request count and terminal error `kind`.

---

## Phase 4 — Resources and time (1 day)

### 4.1 Signal handling without leaks — #7
- **Files:** `src/queue/executor.ts`, `src/core/client.ts`
- **Change:** `AbortSignal.any([...])` per attempt (Node 20+); remove the external-signal listener in `markDone`/`cancel`.
- **Acceptance:** after a ticket with `maxRetries: 8` resolves, `getEventListeners(ticket.signal, "abort").length === 0` and the caller's signal listener count returns to its pre-request value.

### 4.2 Timeout covers the body — #9
- **Change:** keep the attempt controller alive until `response.json()` (or the caller-facing body) resolves; only then `clearTimeout`.
- **Acceptance:** server sends headers immediately, body after 500 ms, `attemptMs: 100`, `parse` set → `TimeoutError` within ~150 ms.

### 4.3 Total deadline — R3
- **Files:** `src/queue/retry.ts`, `src/core/client.ts`, `src/core/types.ts`
- **Change:** `timeout.totalMs` starts at `request()`; a single `unref`ed timer; on expiry cancel the in-flight attempt and resolve `DeadlineExceededError`, including while queued or sleeping.
- **Acceptance:** `totalMs: 300`, server always 503, `baseDelayMs: 100` → resolves with `DeadlineExceededError` between 300–400 ms; bulkhead `running` returns to 0.

### 4.4 Graceful shutdown — O4
- **Files:** `src/core/client.ts`
- **Change:** `close({ drain = true, timeoutMs })`: reject new requests with `ConfigurationError("client closed")`; if `drain`, await in-flight tickets up to `timeoutMs`, then cancel the rest; clear timers. All backoff/deadline timers `unref()`ed from day one.
- **Acceptance:** process with one sleeping retry exits promptly after `close({ drain: false })`; `close()` with drain waits for a succeeding request.

---

## Phase 5 — Concurrency semantics (1–2 days)

### 5.1 Per-attempt bulkhead scheduling — #5, D4
- **Files:** `src/queue/bulkhead.ts` (`run(task)` returning the task's value), `src/queue/retry.ts`, `src/core/client.ts`
- **Acceptance:** `concurrency: 1`, two failing tickets, `baseDelayMs: 300` → at t≈150 ms `running === 0`; both tickets complete.

### 5.2 Real global semaphore — #2, D1
- **Files:** new `src/queue/semaphore.ts`, `src/queue/bulkhead.ts`, `src/core/client.ts`
- **Change:** `concurrency` (global, default 50) is a semaphore acquired inside `Bulkhead.run` after the partition slot; `defaultPartition` supplies per-partition defaults (5/100).
- **Acceptance:** `concurrency: 2`, three partitions each with `concurrency: 5`, 6 slow failing requests → never more than 2 in flight (server-side concurrent-connection counter); README defaults table regenerated and asserted by test.

### 5.3 Origin partition key — #24
- **Acceptance:** `http://h:1` and `http://h:2` land in different partitions; `partition: "x"` still overrides.

### 5.4 Expose snapshots — #19
- **Change:** `client.partitions(): PartitionSnapshot[]` (`name, running, queued, concurrency, maxQueueSize`).
- **Acceptance:** snapshot reflects a queued ticket, then returns to zeros.

### 5.5 Optional first-attempt limiting — R6
- **Change:** `partition.limitFirstAttempts: boolean` (default false) routes the first attempt through the bulkhead.
- **Acceptance:** with it on and `concurrency: 1`, two fresh requests are serialized.

### 5.6 Honor partition `retry`/`timeout` — #23
- **Change:** merge global → partition → request per namespace.
- **Acceptance:** partition `retry.maxRetries: 0` overrides global 3; request-level overrides partition.

---

## Phase 6 — Observability (1 day)

### 6.1 Terminal events with timings — #13, O1, D5
- **Files:** `src/core/types.ts`, `src/core/client.ts`
- **Acceptance:** for each of success / failure / cancelled / queue-full / deadline, exactly one terminal event; `attempts` and `durationMs` populated; `attempt: -1` gone.

### 6.2 Metrics sink — O2
- **Files:** new `src/core/metrics.ts`
- **Change:** `interface MetricsSink { counter(name, value, tags), histogram(name, value, tags), gauge(name, value, tags) }`; client emits `vereda.requests`, `vereda.retries`, `vereda.duration_ms`, `vereda.queue_depth`, `vereda.in_flight` with `partition`/`kind`/`status` tags. Add `examples/otel.ts`.
- **Acceptance:** fake sink records expected series for one success and one exhausted retry.

### 6.3 Log redaction — O3
- **Change:** `redactQuery: true` default strips query values to `?k=[redacted]` in every log/event `url`; headers never logged; per-attempt detail moves to `debug`.
- **Acceptance:** URL with `?token=abc` never appears verbatim in logger calls.

### 6.4 Injectable `fetch` — O5
- **Change:** `ClientConfig.fetch?: typeof fetch`, threaded into `buildFetchCall`.
- **Acceptance:** unit tests for executor use a stub fetch; no socket opened.

---

## Phase 7 — API freeze (1 day)

### 7.1 Middleware request context — #11, A2, D6
- **Files:** `src/queue/executor.ts`, `src/middleware/index.ts`, README
- **Acceptance:** middleware can read `ctx.url` and rewrite it; `defaultHeaders({ Authorization })` plus request header `authorization` → exactly one header sent (request wins); README middleware example typechecks (add it as a test file under `test/docs/`).

### 7.2 Honest generics and `json` helper — #10, A3, A6
- **Change:** overloads so `get(url)` is `Ticket<undefined>`; export `json<T>(): ParseFn<T>` that parses JSON without validation; add `head()`, `options()`.
- **Acceptance:** type test (`expectTypeOf`) for both overloads; `parse: json<User>()` returns typed data.

### 7.3 Remove deprecated names and publish `1.0.0-rc.1` — A5
- **Change:** confirm no `maxAttempts`, `trigger`, `queueOnStatus`, `_mark*` remain in `src/`, tests, or docs; bump version; tag.
- **Acceptance:** `grep` clean; `npm pack --dry-run` lists only `dist/`, `README.md`, `LICENSE`.

---

## Phase 8 — Packaging, CI, release (½–1 day)

### 8.1 `package.json` hygiene — P2, P3
- `exports` with `types` first; remove `main`/`types`; `sideEffects: false`; `engines.node: ">=20"`; `repository`, `bugs`, `homepage`; `files: ["dist", "README.md", "LICENSE"]`; remove `prepare` (publish prebuilt); add `prepublishOnly: npm run build && npm test`.
- **Acceptance:** `npx publint` and `npx @arethetypeswrong/cli --pack` report no errors.

### 8.2 CI — Q1, Q2, Q3
- Matrix 20/22/24; steps: `npm ci`, typecheck, lint, `prettier --check`, `vitest run --coverage` with 90% line threshold on `src/`, build, publint. Convert timing tests to `vi.useFakeTimers()` where they measure delays.
- **Acceptance:** CI green; coverage report uploaded as artifact.

### 8.3 Release workflow — P1, P4
- `release.yml` on tag `v*`: build, test, `npm publish --provenance --access public`; GitHub Release from `CHANGELOG.md` section. Add `CHANGELOG.md` (Keep a Changelog) with the full 1.0.0 entry summarising breaking changes vs. the GitHub-installed 0.x.
- **Acceptance:** dry run against a tag on a fork or with `--dry-run`.

---

## Phase 9 — Documentation (1 day)

### 9.1 README rewrite for 1.0 — D1, D2
- Hero example with `baseUrl`; "What gets retried" table near the top with the idempotency warning; defaults table generated/asserted; error table with `kind` column; middleware and events sections updated to D5/D6; remove "Early stage" banner, add versioning policy and Node support policy.

### 9.2 API reference — D3
- `typedoc` with `stripInternal`; publish to GitHub Pages via a `docs.yml` workflow; JSDoc every public option with `@default`.

### 9.3 Operations guide — D4
- `docs/operations.md`: sizing concurrency/queues, choosing `attemptMs` vs `totalMs`, reading `partitions()`, metrics wiring, shutdown sequence, redaction.

### 9.4 Internal docs — D5
- `AGENTS.md` invariants: per-attempt scheduling, default retry policy, one terminal event, `kind` discriminant, npm-only. `ONBOARDING.md` request flow updated. `GOOD_FIRST_ISSUES.md` regenerated with real items (e.g. R4/R5 sub-tasks).

---

## Phase 10 — Post-1.0 (1.x, optional)

- **R4 Retry budget** — `partition.retryBudget: { ratio, windowMs }`; retries beyond budget resolve with the last error and emit a `budget_exhausted` metric.
- **R5 Circuit breaker** — `partition.breaker: { failureThreshold, cooldownMs }`; new `CircuitOpenError` (`kind: "circuit_open"`), half-open probe.

---

## Traceability

| REVIEW item | Task |
| --- | --- |
| #1 | 0.1, 0.3 |
| #2 | 5.2 |
| #3 | 1.1 |
| #4 | 2.1, 2.2 |
| #5 | 5.1 |
| #6 | 1.2 |
| #7 | 4.1 |
| #8 | 1.3 |
| #9 | 4.2 |
| #10 | 7.2 |
| #11 | 7.1 |
| #12 | 2.3 |
| #13 | 6.1 |
| #14, #15 | 0.2, 8.2 |
| #16 | 1.4 |
| #17 | 0.1, 9.4 |
| #18 | 1.5 |
| #19 | 5.4 |
| #20 | 2.2 |
| #21 | tests in every task; 3.6 |
| #22 | 3.1–3.3 |
| #23 | 2.4, 5.6 |
| #24 | 5.3 |
| #25 | 1.5 |
| R1 | 3.4 · R2 | 3.2 · R3 | 4.3 · R4/R5 | Phase 10 · R6 | 5.5 |
| O1 | 6.1 · O2 | 6.2 · O3 | 6.3 · O4 | 4.4 · O5 | 6.4 |
| A1 | 2.1 · A2 | 7.1 · A3 | 7.2 · A4 | 3.3 · A5 | 7.3 · A6 | 7.2 |
| P1 | 8.3 · P2 | 8.1 · P3 | 8.1 · P4 | 8.3 · P5 | 0.2 |
| Q1–Q3 | 8.2 · Q4 | 3.6 · Q5 | 4.1, 5.1, 5.2 |
| D1 | 0.1, 9.1 · D2 | 3.5, 9.1 · D3 | 9.2 · D4 | 9.3 · D5 | 9.4 |

## Progress

Tick as PRs merge.

- [ ] Phase 0 — 0.1 · 0.2 · 0.3
- [ ] Phase 1 — 1.1 · 1.2 · 1.3 · 1.4 · 1.5
- [x] Phase 2 — 2.1 · 2.2 · 2.3 · 2.4
- [ ] Phase 3 — 3.1 · 3.2 · 3.3 · 3.4 · 3.5 · 3.6
- [ ] Phase 4 — 4.1 · 4.2 · 4.3 · 4.4
- [ ] Phase 5 — 5.1 · 5.2 · 5.3 · 5.4 · 5.5 · 5.6
- [ ] Phase 6 — 6.1 · 6.2 · 6.3 · 6.4
- [ ] Phase 7 — 7.1 · 7.2 · 7.3 (rc.1)
- [ ] Phase 8 — 8.1 · 8.2 · 8.3
- [ ] Phase 9 — 9.1 · 9.2 · 9.3 · 9.4
- [ ] Tag `v1.0.0`

## Discovered

Problems found while executing that are not covered above. Add a line, do not fix in the current task unless trivial.

- (none yet)
