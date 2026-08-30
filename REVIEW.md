# Vereda — review and road to a production-ready 1.0.0

**Date:** 2026-08-29 · **Commit:** `847435f` (main) · **Scope:** all of `src/`, `test/`, docs, CI and packaging.

**Baseline:** `tsc --noEmit` clean, `eslint .` clean, `vitest run` 40/40 passing. Every finding marked **verified** was reproduced with a script against the real code (`node:http` server + `HttpClient`), not inferred from reading alone.

This document has two parts:

- **Part 1 — Defects.** Bugs and gaps in the code as it exists today (25 findings, ranked).
- **Part 2 — Production readiness.** Improvements the library needs before `1.0.0` can honestly mean "safe to depend on in production", grouped by theme, each with a concrete suggestion. Ends with a definition-of-done checklist.

Severity: **High** = wrong behavior a normal user will hit or a documented feature that does not exist · **Medium** = incorrect/misleading behavior in edge cases, leaks, API holes · **Low** = polish, docs drift, hygiene.

---

# Part 1 — Defects

## Summary

| # | Severity | Area | Finding |
| --- | --- | --- | --- |
| 1 | High | Client | Relative URL without `baseUrl` throws synchronously from `client.get()` — the README hero example crashes |
| 2 | High | Config | "Global concurrency" is not a global cap; it silently becomes the per-partition default (10, not the documented 5) |
| 3 | High | Events | `retry` lifecycle event is declared and documented but never emitted |
| 4 | High | Errors | Busy statuses (`queueOnStatus`, e.g. 429) are reported as `TimeoutError` — `retryWhen` and callers cannot tell "busy" from "slow" |
| 5 | High | Queue | A bulkhead slot is held for the whole retry loop, including backoff sleeps (up to 30 s per slot) |
| 22 | High | Safety | Non-idempotent requests (POST/PATCH) and all 4xx responses are retried by default; stream bodies fail on every attempt |
| 6 | Medium | Queue | First retry runs with zero backoff and emits no `retrying` update |
| 7 | Medium | Leaks | Abort listeners accumulate on the ticket signal and the caller's `AbortSignal`; never removed |
| 8 | Medium | Errors | `MaxRetriesExceededError.attempts` undercounts by one (says 3, server saw 4) |
| 9 | Medium | Timeout | `timeoutMs` does not cover body reading — a slow body hangs forever |
| 10 | Medium | Types | `Result<T>.data` is typed `T` but is `undefined` whenever no `parse` is given |
| 11 | Medium | Middleware | Middleware cannot see the URL; README example `options.url` does not compile |
| 12 | Medium | Errors | Queue-full is a generic `NetworkError`, indistinguishable from a real network failure |
| 13 | Medium | Events | `success` after retries emits `attempt: -1`; cancellations emit no lifecycle event |
| 23 | Medium | Config | `PartitionConfig.trigger` / `retry` are accepted by the type but ignored; no config validation (`maxAttempts: 0` yields "failed after 0 attempts … timed out after 0ms") |
| 24 | Medium | Queue | Partition key is `hostname`, not `host` — two services on the same host with different ports share one bulkhead |
| 14 | Low | Tooling | `pnpm-workspace.yaml` contains a literal placeholder that breaks `pnpm test` / `pnpm lint` |
| 15 | Low | CI | CI runs `npm install` (ignores `pnpm-lock.yaml`) and never runs lint or format check |
| 16 | Low | Code | `ValidationError` detected via `constructor.name` string instead of `instanceof` |
| 17 | Low | Docs | AGENTS.md and GOOD_FIRST_ISSUES.md still cite stale test counts (36/30 vs actual 40) |
| 18 | Low | API | `Ticket.off()` signature rejects the listener types `on()` accepts |
| 19 | Low | Ops | `bulkheads.getAll()` snapshot exists but is not exposed on `HttpClient` |
| 20 | Low | Resources | Response bodies on busy/non-2xx responses are never consumed or cancelled |
| 21 | Low | Tests | Coverage gaps: queue-full via client, `retry` event, partition config through client, middleware helpers, relative URL |
| 25 | Low | API | `Ticket._markDone` / `_markQueued` / `_markRetrying` are public on the exported class — consumers can corrupt ticket state |

## High

### 1. Relative URL without `baseUrl` throws synchronously — **verified**

`src/core/client.ts:87` does `new URL(fullUrl).hostname` to pick the partition. With no `baseUrl`, a relative path is an invalid URL and `client.get("/users/1")` throws `TypeError: Invalid URL` **before** returning a ticket.

```
HttpClient.create().get("/users/1")  →  throws "Invalid URL"
```

The README's first code block (`HttpClient.create({ retry, trigger, partitions })` then `client.get("/users/1")`) is exactly this case. It also contradicts the "`toPromise()` never rejects / errors are a `Result`" contract — this is the one error a caller must `try/catch`.

**Suggestion:** resolve the partition lazily inside the `_fireFirstAttempt` promise chain so the error lands in the ticket as a `Result` (a new `ConfigurationError` or `NetworkError`), or validate in `request()` and return an already-failed ticket. Fix the README example to include `baseUrl`.

### 2. "Global concurrency" is actually the per-partition default — **verified**

`src/core/client.ts:28-31` passes `{ concurrency: config.concurrency ?? 10 }` as the *global* `PartitionConfig` to `BulkheadRegistry`, which spreads it into every partition (`bulkhead.ts:99-102`). There is no cross-partition cap anywhere. Consequences:

- `ClientConfig.concurrency` ("Global concurrency across all partitions") is not what it says: 8 partitions × 10 = 80 concurrent retries.
- The README defaults table says per-partition concurrency is 5. The `Bulkhead` default of 5 is unreachable from `HttpClient`; the real default is **10**.

```
HttpClient.create({ concurrency: 10 }).bulkheads.get("a.example").concurrencyLimit → 10   (docs: 5)
```

**Suggestion:** implement a real global semaphore that each bulkhead acquires before running a task (global cap *and* per-partition cap, both enforced), and rename the per-partition default to `defaultPartition: PartitionConfig`. Update the README defaults table from the code.

### 3. `retry` lifecycle event never emitted — **verified**

`LifecycleEventMap.retry` is typed (`types.ts:87`), documented in README ("Lifecycle events"), but `grep '"retry"' src/` returns nothing. `client.on("retry", …)` is a listener that never fires. Retry information exists only on the per-ticket `retrying` update, so fleet-level retry metrics — the stated purpose of lifecycle events — are impossible.

```
maxAttempts=12, all 429 → 'retry' lifecycle events emitted: 0
```

**Suggestion:** `runRetryLoop` takes an `onRetry(attempt, delayMs, error)` callback (or the client's emitter) invoked next to `ticket._markRetrying`. Add a test asserting the event count equals the number of retries.

### 4. Busy status codes are reported as `TimeoutError` — **verified**

`client.ts:166-169` and `retry.ts:75-77` collapse `queued_status` into `new TimeoutError(url, triggerConfig.timeoutMs ?? 0)`. A 429 with no timeout configured produces the error message `"Request to … timed out after 0ms"`.

```
503 ×4 with queueOnStatus:[503] → MaxRetriesExceededError.lastError = TimeoutError "timed out after 1000ms"
```

Effects: `retryWhen` cannot implement "retry on 429 but not on timeout"; `lastError` lies about what happened; the `Response` (and `Retry-After` header) is dropped. Commit `a6b4c0c` introduced a `RetryableStatusError` for this and was reverted in `19bbf2c`, so the gap is known but currently open.

**Suggestion:** add `RetryableStatusError { statusCode, response, retryAfterMs? }` to the `AppError` union; honor `Retry-After` (see Part 2, R1).

### 5. Bulkhead slot held during backoff sleep — **verified**

`_scheduleInBulkhead` wraps the *entire* `runRetryLoop` in one `bulkhead.schedule()` task. The loop `await sleep(delayMs)` while holding the slot, so with default backoff (cap 30 s) a partition of concurrency 5 can have all 5 slots occupied by tickets that are doing nothing but sleeping. The README describes the limit as "in-flight retries"; it is really "retry loops, including their idle time".

```
concurrency:1, two failing tickets, baseDelayMs:300 → during sleep: running=1 queued=1
```

**Suggestion:** schedule each *attempt* through the bulkhead and sleep outside it (release → sleep → re-acquire). Queue position should be re-acquired after the sleep so that a partition's slots are always doing network work.

### 22. Unsafe retry defaults for non-idempotent requests, 4xx, and stream bodies — **verified**

Three related problems in the default retry policy:

- **Non-idempotent methods are retried.** `client.post()` / `patch()` go through the same loop as GET. A POST that timed out after the server processed it (the classic case) is replayed up to 3 more times by default: duplicate orders, duplicate payments. Nothing in the library or docs warns about this.
- **All non-2xx are retried.** A 404 or 400 is retried 4 times with backoff:
  ```
  404 → server hits: 4 | error: MaxRetriesExceededError
  ```
  Client errors are deterministic; retrying them wastes the caller's latency budget and the server's capacity. The README even states "all non-2xx responses are retried as errors" as if it were a feature.
- **Stream bodies fail on every attempt.** A `ReadableStream` body is rejected by undici without `duplex: "half"`, the `TypeError` becomes a `NetworkError`, and the request is retried 4 times with the same result. Even with `duplex` set, a one-shot stream is consumed by attempt 1 and replayed empty on attempt 2.
  ```
  POST with ReadableStream body → MaxRetriesExceededError, server received 0 bodies
  ```

**Suggestion:** ship a conservative default policy: retry network errors, timeouts, 408/425/429/5xx; do *not* retry other 4xx; retry non-idempotent methods only when the caller opts in (`retry: { idempotent: true }` or an `Idempotency-Key` header is present). Reject `ReadableStream` bodies with a clear `ConfigurationError` unless a `body: () => BodyInit` factory is supplied for replay. Document the policy in a "What gets retried" table.

## Medium

### 6. First retry has zero backoff and no `retrying` update — **verified**

`retry.ts:31` only applies backoff and `_markRetrying` when `attempt > 0`. Loop iteration 0 is already the *second* execution (the first ran outside the loop), so the first retry fires immediately after queuing (measured gap: 6 ms) with no backoff and no `retrying` event. For `queueOnStatus: [429]` this means the client immediately re-hits a server that just said "slow down". The ticket update stream shows `queued, retrying:1, retrying:2, …` — there is never a `retrying:0`, and for `maxAttempts: 1` the stream is `queued, done` with no `retrying` at all.

**Suggestion:** treat loop iteration 0 as a retry: `backoffFn(attempt)` and `_markRetrying(attempt + 1, …)` for every iteration.

### 7. Abort listeners accumulate and are never removed — **verified**

`executor.ts:mergeSignals` registers `{ once: true }` listeners on the ticket signal and on `options.signal` for **every attempt**; they only fire on abort, so on success/exhaustion they stay forever. `client.ts:81` also adds a listener to the caller's signal that is never removed when the ticket resolves.

```
maxAttempts=8 → 9 listeners on ticket.signal; 10 listeners on the caller's AbortSignal after the ticket is done
```

A long-lived caller signal (e.g. a server's shutdown signal shared across thousands of requests) grows unboundedly; each closure captures a controller and a ticket.

**Suggestion:** use `AbortSignal.any()` (Node ≥ 20) or return a cleanup function from `mergeSignals` and call it in a `finally`; remove the external `abort` listener in `_markDone`/`cancel`.

### 8. `MaxRetriesExceededError.attempts` off by one — **verified**

`retry.ts:88` passes `maxAttempts`, but total executions are `maxAttempts + 1` (first attempt outside the loop). Message says "failed after 3 attempts"; the server received 4 requests. README itself says "`maxAttempts: 3` → 4 total executions", so the error and the docs disagree.

**Suggestion:** report total executions, and rename the option to `maxRetries` (or make `maxAttempts` mean total attempts) so the name matches the number.

### 9. `timeoutMs` does not cover body reading

`executor.ts:55-59` clears the timeout right after headers arrive; `response.json()` at line 108 runs with no deadline and outside any timeout signal. A server that sends headers then trickles the body hangs the ticket indefinitely. Only relevant when `parse` is set (otherwise the body is the caller's problem — but the caller has no deadline either).

**Suggestion:** keep the timeout signal alive until the body is consumed; add a separate `totalTimeoutMs` deadline for the whole ticket (Part 2, R3).

### 10. `Result<T>.data` lies when there is no `parse`

`executor.ts:136` returns `data: undefined` typed as `T`. `client.get<User>("/u")` gives `result.data.name` as `string` in the type system and a runtime `TypeError`.

**Suggestion:** overloads — `get(url)` returns `Ticket<undefined>`; `get(url, { parse })` returns `Ticket<T>`. Or default to `Ticket<unknown>` and parse the body as JSON when the `Content-Type` is JSON.

### 11. Middleware cannot see the URL; README example does not compile

`MiddlewareFn` receives `RequestOptions`, which has no `url` field, and `buildFetchCall` closes over the URL. The README "Middleware" section does `console.log("Request:", options.url)` — a type error for anyone who copies it. Middleware also cannot rewrite the URL (signing, path prefixes).

**Suggestion:** pass a request object `{ url, method, headers, body, signal, attempt, ticketId }` to middleware and let it return/modify it.

### 12. Queue-full is an anonymous `NetworkError`

`client.ts:244` maps the bulkhead's rejection to `NetworkError("Bulkhead 'x' queue is full …")` with no `statusCode`. Callers cannot distinguish local backpressure from a real network failure without string-matching the message; `retryWhen` never sees it either.

**Suggestion:** `QueueFullError { partition, queueSize, maxQueueSize }` in the `AppError` union.

### 13. Lifecycle event inconsistencies

- `success` after retries is emitted with `attempt: -1` (`client.ts:232`) as a sentinel; the type says `number`. The real attempt number is available on the ticket status.
- Cancellation never emits a `failure` (or any) lifecycle event, so a metrics consumer sees `request` with no terminal event.
- The catch-all in `request()` (`client.ts:107-115`) resolves the ticket but emits no `failure`.

**Suggestion:** every ticket emits exactly one terminal lifecycle event (`success` | `failure` | `cancelled`), each carrying `attempts`, `durationMs`, and `partition`.

### 23. `PartitionConfig.trigger`/`retry` ignored; no config validation — **verified**

`PartitionConfig` (`types.ts:46-53`) declares `trigger` and `retry`, and the README notes they are "currently ignored". A type that accepts settings that do nothing is a trap. Separately, nothing validates configuration:

```
maxAttempts: 0 → MaxRetriesExceededError "Request failed after 0 attempts: … timed out after 0ms"
```

Negative `concurrency`, `maxQueueSize: 0`, `timeoutMs: -1` and `baseDelayMs > maxDelayMs` are all accepted silently.

**Suggestion:** either implement the per-partition merge (global → partition → request; the reverted `a6b4c0c` did this) or remove the fields from the type. Validate config in `HttpClient.create()` and throw a `ConfigurationError` with the offending key — configuration errors are the one place where throwing at construction time is the right behavior.

### 24. Partition key ignores the port — **verified**

`client.ts:87` keys the bulkhead by `new URL(url).hostname`. `http://svc:8080` and `http://svc:9090` are different services but share one queue and one concurrency limit; the failure of one throttles the other.

**Suggestion:** key by `origin` (scheme + host + port) by default; keep `partition` as the explicit override.

## Low

### 14. `pnpm-workspace.yaml` contains a literal placeholder — **verified**

```yaml
allowBuilds:
  esbuild: set this to true or false
```

This is the text pnpm prints as a hint; it was committed verbatim. Result: `pnpm test`, `pnpm lint`, `pnpm typecheck` all fail locally with `ERR_PNPM_IGNORED_BUILDS`. Set `esbuild: true` (or delete the file; `npm` is what CI and the docs use).

### 15. CI ignores the lockfile and skips lint/format

`.github/workflows/ci.yml` runs `npm install`, which neither reads `pnpm-lock.yaml` nor produces a committed `package-lock.json` (gitignored), so CI dependency versions float. Lint (`eslint`) and `prettier --check` are configured and documented as pre-commit steps but never enforced in CI. Node 18 is EOL (April 2025) yet is the advertised floor.

### 16. `ValidationError` detected by `constructor.name`

`client.ts:147` compares `result.error.constructor.name === "ValidationError"`. `ValidationError` is imported in the same module; use `instanceof`. Name-based checks break under minification and subclassing.

### 17. Stale test counts in contributor docs

- `AGENTS.md:25`: "it claims 36 tests; suite has 30" — both numbers are stale (suite has 40, README says 40).
- `GOOD_FIRST_ISSUES.md` #1: asks a newcomer to change "36" to "30"; the README already says 40. The issue is obsolete and would mislead a first contributor — exactly what the file promises not to do.
- `CONTRIBUTING.md:5` says the skill is bundled in `.claude/skills/` and `.opencode/skills/`; only `.opencode/skills/guide-me/SKILL.md` is tracked in git.

### 18. `Ticket.off()` signature mismatch

`on()` accepts `(result: Result<T>) => void`, but `off(event: string, listener: (...args: unknown[]) => void)` rejects that same function under `strictFunctionTypes`. Mirror the `on()` overloads.

### 19. Bulkhead snapshot not exposed

`BulkheadRegistry.getAll()` returns a useful `{ running, queued, concurrency, maxQueueSize }` snapshot but `HttpClient.bulkheads` is private. Expose it (e.g. `client.partitions()`) — it is the only way to observe backpressure before it turns into queue-full errors.

### 20. Unconsumed response bodies

On `queued_status` and non-2xx (`executor.ts:89-101`) the `Response` is returned or discarded without `body.cancel()`/consumption. Undici keeps the connection busy until the body is drained or GC'd; under sustained 429s this can hold sockets. Call `response.body?.cancel()` when the body will not be read.

### 21. Test coverage gaps

No test exercises: queue-full → ticket resolution through `HttpClient`; the `retry` lifecycle event (would have caught #3); partition `concurrency`/`maxQueueSize` through the client (would have caught #2); `defaultHeaders`/`requestLogger`; `subscribe()` on an already-terminal ticket; `Ticket.off()`; relative URL handling (would have caught #1); the `attempts` value on `MaxRetriesExceededError` (would have caught #8); POST retry semantics (#22).

### 25. Internal ticket mutators are public API

`Ticket._markDone`, `_markQueued`, `_markRetrying` are public methods on the exported class. Any consumer (or middleware) can resolve someone else's ticket. Move them behind a module-private symbol or a separate `TicketController` returned only to the client; mark with `@internal` and enable `stripInternal`.

---

# Part 2 — Production readiness

Fixing Part 1 gives a *correct* library. The items below are what separates "correct" from "I would put this in front of production traffic and sleep at night". They are grouped by theme; each has a suggestion concrete enough to become an issue.

## R. Resilience semantics

**R1. Honor `Retry-After`.** When a 429/503 carries `Retry-After` (seconds or HTTP-date), use it as the backoff for that retry (capped by `maxDelayMs`) instead of the computed exponential value. Requires #4 so the response reaches the retry loop.

**R2. Conservative, documented default retry policy** (#22). Retry: network errors, timeouts, 408, 425, 429, 5xx. Do not retry: other 4xx, `ValidationError`, non-idempotent methods without opt-in. Expose the policy as a named export (`defaultRetryPolicy`) so users can extend rather than rewrite it.

**R3. Total deadline.** Add `totalTimeoutMs` (whole ticket, across all attempts and queue time) alongside the per-attempt `timeoutMs`. Without it a request with `maxAttempts: 5` and 30 s backoff cap can take minutes; production callers need a bound they can reason about. The ticket resolves with `TimeoutError` (or a new `DeadlineExceededError`) when it fires, even while queued.

**R4. Retry budget.** A per-partition retry budget (e.g. "retries may be at most 20% of requests over a sliding window") prevents retry storms when a dependency is fully down — the situation where exponential backoff alone is not enough. Optional, off by default, but a real 1.0 resilience library should offer it.

**R5. Circuit breaker (optional).** With #19 exposing partition health, a simple breaker (open after N consecutive failures, half-open probe after cooldown) is a small addition and the most-requested feature of this class of library. Ship it as opt-in per partition.

**R6. Bulkhead for first attempts (opt-in).** Today the first attempt is deliberately unbounded. Keep that default but offer `partitions.x.limitFirstAttempts: true` for callers who need a hard cap on connections to a fragile dependency.

## O. Operability

**O1. One terminal event per ticket with timings** (#13). `success`/`failure`/`cancelled` carry `attempts`, `durationMs`, `queuedMs`, `partition`, `statusCode`. This is what a metrics adapter needs.

**O2. Metrics adapter surface.** `client.on(…)` is enough for logs, not for metrics. Provide a `MetricsSink` interface (`counter`, `histogram`, `gauge`) fed by the client, plus partition gauges (running, queued) from #19. Ship an OpenTelemetry example.

**O3. Structured, redacted logging.** The logger receives full URLs; query strings often contain tokens. Redact query parameters by default (`redactQuery: true`) and never log headers. The `debug` level is currently unused — use it for per-attempt detail so `info` stays quiet in production.

**O4. Graceful shutdown.** Add `client.close({ drain?: boolean, timeoutMs? })`: stop accepting new requests, optionally wait for in-flight tickets, cancel the rest, clear timers. Backoff `setTimeout`s should be `unref()`ed so a pending retry never keeps a process alive.

**O5. Injectable `fetch`.** `HttpClient.create({ fetch })` — needed for undici `Agent` tuning (keep-alive, connection limits, proxies), for tests without a socket, and for platforms whose global `fetch` differs. It is also the cleanest way to add tracing headers.

## A. API and type surface

**A1. Freeze the error model.** Add a string `kind` discriminant to every `AppError` (`"network" | "timeout" | "retryable_status" | "validation" | "cancelled" | "max_retries" | "queue_full" | "configuration"`). `instanceof` fails across duplicated bundles; a discriminant does not. Keep the classes for stack traces.

**A2. Request object for middleware** (#11). `{ url, method, headers: Headers, body, signal, attempt, ticketId }`; middleware may return a modified request. Accept `HeadersInit` everywhere and merge case-insensitively (`defaultHeaders` currently produces both `authorization` and `Authorization`).

**A3. Honest generics** (#10). `Ticket<undefined>` without `parse`, `Ticket<T>` with it.

**A4. Replayable bodies** (#22). Accept `body: BodyInit | (() => BodyInit)`; reject `ReadableStream` without a factory.

**A5. Hide internals** (#25) and stabilise names. Decide `maxAttempts` vs `maxRetries` (#8), `partition` vs `origin` default (#24), `concurrency` vs `defaultPartition.concurrency` (#2) *before* 1.0 — every one of these is a breaking change afterwards.

**A6. Convenience that production code needs.** `head()`, `options()`; a `json` shortcut (`client.get(url).json<T>()` or `parse: json<T>()` helper) so the common case does not require a schema library; `AbortSignal.timeout()` interop.

## P. Packaging and release

**P1. Publish to npm.** Installing from GitHub runs `prepare` → `tsc` on every consumer's machine, requires their `npm install` to pull devDependencies, and makes `files: ["dist"]` meaningless. A 1.0 should be `npm install vereda` with a prebuilt `dist/`, a tag per release, GitHub Releases, and npm provenance (`--provenance` from CI).

**P2. `package.json` hygiene.** `exports` conditions with `"types"` first; `"sideEffects": false`; `"engines": { "node": ">=20" }`; `repository`, `bugs`, `homepage`; drop `main`/`types` in favour of `exports` only. Run `publint` and `@arethetypeswrong/cli` in CI.

**P3. Node support policy.** Drop 18 (EOL); support 20, 22, 24 in the matrix; state the policy in the README. Unlocks `AbortSignal.any` (#7) and `Promise.withResolvers`.

**P4. Versioning and changelog.** Adopt semver explicitly, keep `CHANGELOG.md` (Keep a Changelog format), and document what counts as a breaking change (error class names, event payloads, defaults). Consider `changesets` for automation.

**P5. Reproducible installs.** Pick one package manager. If pnpm: `pnpm/action-setup` + `pnpm install --frozen-lockfile` in CI and fix #14. If npm: commit `package-lock.json` and use `npm ci`.

## Q. Quality gates

**Q1. CI runs everything** (#15): typecheck, lint, `prettier --check`, tests with coverage, build, `publint`. Fail on warnings from `no-explicit-any`.

**Q2. Coverage threshold.** Add `@vitest/coverage-v8` with a floor (e.g. 90% lines on `src/`); the gaps in #21 are where the bugs were.

**Q3. Deterministic timing tests.** Use `vi.useFakeTimers()` for backoff/timeout tests instead of real 10 ms sleeps; the suite is fast today but timing tests are the first to flake on shared CI runners.

**Q4. Behavioral test matrix.** One integration test per row of the "what gets retried" table (R2): method × status × body type × idempotency flag. This is the contract users depend on; it should be executable.

**Q5. Concurrency and leak tests.** Assert listener counts return to baseline after a ticket resolves (#7); assert bulkhead `running` returns to 0 after backoff (#5); assert a global cap holds across partitions (#2).

## D. Documentation

**D1. Fix contradictions** (#1, #2, #11, #17): hero example needs `baseUrl`; defaults table; middleware `options.url`; test counts; `.claude/skills` reference. Regenerate the defaults table from code in a test so it cannot drift again.

**D2. "What gets retried" table and idempotency warning** near the top of the README — the single most important thing a production user needs to know.

**D3. API reference.** Generate with TypeDoc from the `@internal`-stripped declarations; publish to GitHub Pages. JSDoc every public option with its default.

**D4. Operations guide.** Sizing `concurrency`/`maxQueueSize`, choosing `timeoutMs` vs `totalTimeoutMs`, reading partition snapshots, wiring metrics, shutdown sequence.

**D5. Update the internal docs.** AGENTS.md "Gotchas" and ONBOARDING.md must reflect the new invariants (per-attempt bulkhead scheduling, retry policy, error `kind`s).

---

# 1.0.0 definition of done

Ordered so that each step unblocks the next.

- [ ] **Unblock local dev and the README** — #1, #14, #17 (D1).
- [ ] **Retry loop correctness** — #3, #6, #8, #16, #25; tests for each (Q5).
- [ ] **Error model** — #4, #12, #23 (`ConfigurationError`), A1 `kind` discriminant; re-land the intent of `a6b4c0c`.
- [ ] **Safe defaults** — #22 / R2 default policy, A4 replayable bodies, R1 `Retry-After`; D2 table; Q4 matrix.
- [ ] **Resource correctness** — #7, #9, #20, O4 shutdown + `unref`.
- [ ] **Concurrency semantics** — #2 (real global cap), #5 (per-attempt scheduling), #24 (origin key), #19 (snapshot exposed); Q5 tests.
- [ ] **Deadlines** — R3 `totalTimeoutMs`.
- [ ] **Observability** — #13 / O1 terminal events with timings, O2 metrics sink, O3 redaction, O5 injectable fetch.
- [ ] **API freeze** — A2, A3, A5 naming decisions, A6 helpers; `Ticket.off()` (#18). Publish a `1.0.0-rc.1`.
- [ ] **Packaging and CI** — P1–P5, Q1–Q3, #15.
- [ ] **Docs** — D3 API reference, D4 operations guide, D5 internal docs, CHANGELOG with the 1.0.0 entry.
- [ ] Optional for 1.0, recommended for 1.x: R4 retry budget, R5 circuit breaker, R6 first-attempt limiting.

## What is already solid

The ticket state machine (`ticket.ts`) is well-guarded: illegal transitions are ignored, double resolution is impossible, `cancel()` is terminal and tested. Cancel-vs-timeout precedence in `executeRequest` is correct and covered by three focused tests. `ValidationError` short-circuiting and `retryWhen(…, 0)` on the first failure both match the documented invariants. Middleware onion composition is correct. The zero-dependency core, ESM-only stance, and self-contained `node:http` integration tests are the right foundations to build 1.0 on.
