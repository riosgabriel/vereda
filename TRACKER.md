# Vereda 1.0.0 — Task Tracker

Source of truth: `PLAN.md`. This file tracks execution status only.

## Phase 0 — Unblock

| # | Task | Status | PR |
|---|------|--------|----|
| 0.1 | README hero example and doc drift | Done | #25 |
| 0.2 | Package manager cleanup | Done | (already in place) |
| 0.3 | Relative-URL crash | Done | (already in place) |

## Phase 1 — Retry loop correctness

| # | Task | Status | PR |
|---|------|--------|----|
| 1.1 | Emit the `retry` lifecycle event | Done | #26 |
| 1.2 | First retry gets backoff and `retrying` update | Done | #27 |
| 1.3 | Rename `maxAttempts` → `maxRetries` | Done | #27 |
| 1.4 | `instanceof` instead of `constructor.name` | Done | #27 |
| 1.5 | Hide ticket mutators | Done | #27 |

## Phase 2 — Error model

| # | Task | Status | PR |
|---|------|--------|----|
| 2.1 | Add `kind` and new error classes | Done | |
| 2.2 | Executor returns typed status errors | Done | |
| 2.3 | Queue-full as `QueueFullError` | Done | |
| 2.4 | Config validation | Done | |

## Phase 3 — Safe defaults and policy

| # | Task | Status | PR |
|---|------|--------|----|
| 3.1 | `retry.retryOnStatus`, remove `trigger` | Pending | |
| 3.2 | `defaultRetryPolicy` and idempotency gate | Pending | |
| 3.3 | Replayable bodies | Pending | |
| 3.4 | Honor `Retry-After` | Pending | |
| 3.5 | "What gets retried" table in README | Pending | |
| 3.6 | Behavioral matrix test | Pending | |

## Phase 4 — Resources and time

| # | Task | Status | PR |
|---|------|--------|----|
| 4.1 | Signal handling without leaks | Pending | |
| 4.2 | Timeout covers the body | Pending | |
| 4.3 | Total deadline | Pending | |
| 4.4 | Graceful shutdown | Pending | |

## Phase 5 — Concurrency semantics

| # | Task | Status | PR |
|---|------|--------|----|
| 5.1 | Per-attempt bulkhead scheduling | Pending | |
| 5.2 | Real global semaphore | Pending | |
| 5.3 | Origin partition key | Pending | |
| 5.4 | Expose snapshots | Pending | |
| 5.5 | Optional first-attempt limiting | Pending | |
| 5.6 | Honor partition `retry`/`timeout` | Pending | |

## Phase 6 — Observability

| # | Task | Status | PR |
|---|------|--------|----|
| 6.1 | Terminal events with timings | Pending | |
| 6.2 | Metrics sink | Pending | |
| 6.3 | Log redaction | Pending | |
| 6.4 | Injectable `fetch` | Pending | |

## Phase 7 — API freeze

| # | Task | Status | PR |
|---|------|--------|----|
| 7.1 | Middleware request context | Pending | |
| 7.2 | Honest generics and `json` helper | Pending | |
| 7.3 | Remove deprecated names, publish `1.0.0-rc.1` | Pending | |

## Phase 8 — Packaging, CI, release

| # | Task | Status | PR |
|---|------|--------|----|
| 8.1 | `package.json` hygiene | Pending | |
| 8.2 | CI | Pending | |
| 8.3 | Release workflow | Pending | |

## Phase 9 — Documentation

| # | Task | Status | PR |
|---|------|--------|----|
| 9.1 | README rewrite for 1.0 | Pending | |
| 9.2 | API reference | Pending | |
| 9.3 | Operations guide | Pending | |
| 9.4 | Internal docs | Pending | |

---

**Progress:** 8 / 30 done
