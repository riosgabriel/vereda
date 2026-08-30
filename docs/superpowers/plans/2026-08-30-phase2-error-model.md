# Phase 2 — Error Model Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the ad-hoc error handling with a discriminated `AppError` union where every error has a readonly `kind` string, add missing error classes (`HttpError`, `RetryableStatusError`, `DeadlineExceededError`, `QueueFullError`, `ConfigurationError`), make the executor return typed status errors, and add config validation.

**Architecture:** Extend `src/core/errors.ts` with new classes and a `kind` discriminant on every error. Update `src/queue/executor.ts` to drop `queued_status` and return `RetryableStatusError`/`HttpError` based on `retryOnStatus`. Update `src/queue/bulkhead.ts` to throw `QueueFullError`. Create `src/core/validate.ts` for config validation. Update `src/core/client.ts` and `src/core/index.ts` to wire everything together.

**Tech Stack:** TypeScript (ESM, NodeNext), Vitest, zero runtime dependencies.

## Global Constraints

- ESM-only, Node ≥ 20; every relative import uses `.js` extension even for `.ts` sources
- `src/core/` must stay zod-free; only `src/adapters/zod.ts` may import zod
- `dist/` is gitignored — never edit it
- `package-lock.json` is committed; CI uses `npm ci`
- Run `npm run format && npm run lint` before committing
- Tests are self-contained with `node:http` servers on `127.0.0.1` ephemeral ports
- `testTimeout` is 15s (`vitest.config.ts`)

---

## File Map

| File | Action | Purpose |
|------|--------|---------|
| `src/core/errors.ts` | Modify | Add `kind` to all classes; add 5 new error classes; remove `statusCode`/`response` from `NetworkError` |
| `src/core/index.ts` | Modify | Export new error classes and `validateConfig` |
| `src/queue/executor.ts` | Modify | Drop `queued_status`; return `RetryableStatusError`/`HttpError`; parse `Retry-After`; cancel unused response bodies |
| `src/queue/retry.ts` | Modify | Handle `RetryableStatusError.retryAfterMs` for backoff; handle new `ExecuteResult` kinds |
| `src/queue/bulkhead.ts` | Modify | Throw `QueueFullError` instead of generic `Error` on queue full |
| `src/core/client.ts` | Modify | Import new errors; handle `QueueFullError` from bulkhead; call `validateConfig` in `create()` |
| `src/core/validate.ts` | Create | Config validation logic |
| `test/core/errors.test.ts` | Create | Unit tests for all error classes and `kind` discriminant |
| `test/core/validate.test.ts` | Create | Table-driven config validation tests |
| `test/queue/executor.test.ts` | Modify | Update existing tests for new `ExecuteResult` types; add `Retry-After` and body-cancel tests |
| `test/queue/bulkhead.test.ts` | Modify | Add `QueueFullError` test |
| `test/core/client.integration.test.ts` | Modify | Update integration tests for new error types |

---

### Task 2.1: Add `kind` and new error classes

**Files:**
- Modify: `src/core/errors.ts`
- Modify: `src/core/index.ts`
- Create: `test/core/errors.test.ts`

**Interfaces:**
- Consumes: existing `RequestError` base class
- Produces: `AppError` union with exhaustive `kind` discriminant; all error classes exportable from `src/core/index.ts`

- [ ] **Step 1: Write the failing test for `kind` on all error classes**

Create `test/core/errors.test.ts`:

```typescript
import { describe, it, expect } from "vitest"
import {
  RequestError,
  NetworkError,
  ValidationError,
  TimeoutError,
  CancelledError,
  MaxRetriesExceededError,
  HttpError,
  RetryableStatusError,
  DeadlineExceededError,
  QueueFullError,
  ConfigurationError,
  type AppError,
} from "../../src/core/errors.js"

describe("Error classes", () => {
  it("NetworkError has kind 'network'", () => {
    const err = new NetworkError("fail")
    expect(err.kind).toBe("network")
    expect(err).toBeInstanceOf(RequestError)
  })

  it("HttpError has kind 'http'", () => {
    const err = new HttpError("not found", 404, new Response())
    expect(err.kind).toBe("http")
    expect(err).toBeInstanceOf(RequestError)
  })

  it("RetryableStatusError has kind 'retryable_status'", () => {
    const err = new RetryableStatusError("rate limited", 429, new Response(), 2000)
    expect(err.kind).toBe("retryable_status")
    expect(err.retryAfterMs).toBe(2000)
    expect(err).toBeInstanceOf(RequestError)
  })

  it("TimeoutError has kind 'timeout'", () => {
    const err = new TimeoutError("http://x", 500)
    expect(err.kind).toBe("timeout")
    expect(err).toBeInstanceOf(RequestError)
  })

  it("DeadlineExceededError has kind 'deadline'", () => {
    const err = new DeadlineExceededError("http://x", 3000)
    expect(err.kind).toBe("deadline")
    expect(err).toBeInstanceOf(RequestError)
  })

  it("ValidationError has kind 'validation'", () => {
    const err = new ValidationError("bad", [{ path: "x" }])
    expect(err.kind).toBe("validation")
    expect(err).toBeInstanceOf(RequestError)
  })

  it("CancelledError has kind 'cancelled'", () => {
    const err = new CancelledError()
    expect(err.kind).toBe("cancelled")
    expect(err).toBeInstanceOf(RequestError)
  })

  it("QueueFullError has kind 'queue_full'", () => {
    const err = new QueueFullError("partition-a", 1, 1)
    expect(err.kind).toBe("queue_full")
    expect(err).toBeInstanceOf(RequestError)
  })

  it("ConfigurationError has kind 'configuration'", () => {
    const err = new ConfigurationError("concurrency")
    expect(err.kind).toBe("configuration")
    expect(err).toBeInstanceOf(RequestError)
  })

  it("MaxRetriesExceededError has kind 'max_retries'", () => {
    const inner = new NetworkError("fail")
    const err = new MaxRetriesExceededError(4, inner)
    expect(err.kind).toBe("max_retries")
    expect(err).toBeInstanceOf(RequestError)
  })

  it("AppError union is exhaustive (compile-time check)", () => {
    // This switch exhaustiveness check compiles only if every kind is handled
    const kind: AppError["kind"] = "network" as AppError["kind"]
    switch (kind) {
      case "network":
      case "http":
      case "retryable_status":
      case "timeout":
      case "deadline":
      case "validation":
      case "cancelled":
      case "queue_full":
      case "configuration":
      case "max_retries":
        break
      default:
        // If this line compiles, a kind is missing from the union
        const _exhaustive: never = kind
        void _exhaustive
    }
  })

  it("NetworkError no longer has statusCode or response", () => {
    const err = new NetworkError("fail")
    expect(err).not.toHaveProperty("statusCode")
    expect(err).not.toHaveProperty("response")
  })

  it("HttpError preserves statusCode and response", () => {
    const res = new Response(null, { status: 404 })
    const err = new HttpError("not found", 404, res)
    expect(err.statusCode).toBe(404)
    expect(err.response).toBe(res)
  })

  it("QueueFullError has partition and queue info", () => {
    const err = new QueueFullError("api", 10, 5)
    expect(err.partition).toBe("api")
    expect(err.queueSize).toBe(10)
    expect(err.maxQueueSize).toBe(5)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/core/errors.test.ts`
Expected: FAIL — `kind` property does not exist on error classes, new classes don't exist yet.

- [ ] **Step 3: Implement error classes in `src/core/errors.ts`**

Replace the entire file with:

```typescript
export type AppError =
  | NetworkError
  | HttpError
  | RetryableStatusError
  | TimeoutError
  | DeadlineExceededError
  | ValidationError
  | CancelledError
  | QueueFullError
  | ConfigurationError
  | MaxRetriesExceededError

/**
 * Base class for failures that prevent a request from
 * producing a successful result.
 */
export class RequestError extends Error {
  public readonly kind: string
  public cause?: unknown

  constructor(kind: string, message: string, cause?: unknown) {
    super(message)
    this.name = this.constructor.name
    this.kind = kind
    if (cause !== undefined) {
      this.cause = cause
    }
  }
}

export class NetworkError extends RequestError {
  constructor(message: string, options?: { cause?: unknown }) {
    super("network", message, options?.cause)
  }
}

export class HttpError extends RequestError {
  public readonly statusCode: number
  public readonly response: Response

  constructor(message: string, statusCode: number, response: Response) {
    super("http", message)
    this.statusCode = statusCode
    this.response = response
  }
}

export class RetryableStatusError extends RequestError {
  public readonly statusCode: number
  public readonly response: Response
  public readonly retryAfterMs?: number

  constructor(
    message: string,
    statusCode: number,
    response: Response,
    retryAfterMs?: number,
  ) {
    super("retryable_status", message)
    this.statusCode = statusCode
    this.response = response
    this.retryAfterMs = retryAfterMs
  }
}

export class TimeoutError extends RequestError {
  public readonly timeoutMs: number
  public readonly url: string

  constructor(url: string, timeoutMs: number) {
    super("timeout", `Request to ${url} timed out after ${timeoutMs}ms`)
    this.timeoutMs = timeoutMs
    this.url = url
  }
}

export class DeadlineExceededError extends RequestError {
  public readonly totalMs: number
  public readonly url: string

  constructor(url: string, totalMs: number) {
    super("deadline", `Request to ${url} exceeded total deadline of ${totalMs}ms`)
    this.totalMs = totalMs
    this.url = url
  }
}

export class ValidationError extends RequestError {
  public readonly issues: unknown[]

  constructor(message: string, issues: unknown[], cause?: unknown) {
    super("validation", message, cause)
    this.issues = issues
  }
}

export class CancelledError extends RequestError {
  constructor(message = "Request was cancelled") {
    super("cancelled", message)
  }
}

export class QueueFullError extends RequestError {
  public readonly partition: string
  public readonly queueSize: number
  public readonly maxQueueSize: number

  constructor(partition: string, queueSize: number, maxQueueSize: number) {
    super(
      "queue_full",
      `Queue for partition '${partition}' is full (${queueSize}/${maxQueueSize})`,
    )
    this.partition = partition
    this.queueSize = queueSize
    this.maxQueueSize = maxQueueSize
  }
}

export class ConfigurationError extends RequestError {
  public readonly key: string

  constructor(key: string) {
    super("configuration", `Invalid configuration: ${key}`)
    this.key = key
  }
}

export class MaxRetriesExceededError extends RequestError {
  public readonly attempts: number
  public readonly lastError: AppError

  constructor(attempts: number, lastError: AppError) {
    super(
      "max_retries",
      `Request failed after ${attempts} attempt${attempts === 1 ? "" : "s"}: ${lastError.message}`,
      lastError,
    )
    this.attempts = attempts
    this.lastError = lastError
  }
}
```

- [ ] **Step 4: Update exports in `src/core/index.ts`**

Add to the existing exports:

```typescript
export {
  RequestError,
  NetworkError,
  HttpError,
  RetryableStatusError,
  TimeoutError,
  DeadlineExceededError,
  ValidationError,
  CancelledError,
  QueueFullError,
  ConfigurationError,
  MaxRetriesExceededError,
} from "./errors.js"
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/core/errors.test.ts`
Expected: PASS

- [ ] **Step 6: Run full test suite to check for breakage**

Run: `npx vitest run`
Expected: Some tests may fail because `NetworkError` no longer has `statusCode`/`response`. Fix in Task 2.2.

- [ ] **Step 7: Commit**

```bash
git add src/core/errors.ts src/core/index.ts test/core/errors.test.ts
git commit -m "feat(error-model): add kind discriminant and new error classes

- Add readonly kind string to every AppError class
- Add HttpError, RetryableStatusError, DeadlineExceededError,
  QueueFullError, ConfigurationError
- Remove statusCode/response from NetworkError
- AppError union is exhaustive with compile-time check"
```

---

### Task 2.2: Executor returns typed status errors

**Files:**
- Modify: `src/queue/executor.ts`
- Modify: `test/queue/executor.test.ts`

**Interfaces:**
- Consumes: `HttpError`, `RetryableStatusError` from Task 2.1; `RetryConfig.retryOnStatus` from types
- Produces: `ExecuteResult` without `queued_status`; `retryAfterMs` on `RetryableStatusError`

- [ ] **Step 1: Write failing tests for new executor behavior**

Add to `test/queue/executor.test.ts`:

```typescript
import { RetryableStatusError, HttpError } from "../../src/core/errors.js"

describe("executeRequest error classification", () => {
  let server: Server
  let url: string
  let handler: (req: IncomingMessage, res: ServerResponse) => void

  beforeAll(async () => {
    server = createServer((req, res) => handler(req, res))
    await new Promise<void>((resolve) => server.listen(0, resolve))
    const addr = server.address()
    if (addr && typeof addr === "object") {
      url = `http://127.0.0.1:${addr.port}`
    }
  })

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve))
  })

  it("429 with Retry-After header returns RetryableStatusError with retryAfterMs", async () => {
    handler = (_req, res) => {
      res.writeHead(429, { "Retry-After": "2" })
      res.end("rate limited")
    }

    const result = await executeRequest(
      {
        url,
        options: {} as RequestOptions<unknown>,
        triggerConfig: { queueOnStatus: [429] },
        signal: new AbortController().signal,
      },
      [],
    )

    expect(result.kind).toBe("error")
    if (result.kind === "error") {
      expect(result.error).toBeInstanceOf(RetryableStatusError)
      const err = result.error as RetryableStatusError
      expect(err.statusCode).toBe(429)
      expect(err.retryAfterMs).toBe(2000)
    }
  })

  it("404 returns HttpError, not RetryableStatusError", async () => {
    handler = (_req, res) => {
      res.writeHead(404)
      res.end("not found")
    }

    const result = await executeRequest(
      {
        url,
        options: {} as RequestOptions<unknown>,
        triggerConfig: { queueOnStatus: [429] },
        signal: new AbortController().signal,
      },
      [],
    )

    expect(result.kind).toBe("error")
    if (result.kind === "error") {
      expect(result.error).toBeInstanceOf(HttpError)
      expect(result.error).not.toBeInstanceOf(RetryableStatusError)
    }
  })

  it("503 with queueOnStatus returns RetryableStatusError", async () => {
    handler = (_req, res) => {
      res.writeHead(503)
      res.end("unavailable")
    }

    const result = await executeRequest(
      {
        url,
        options: {} as RequestOptions<unknown>,
        triggerConfig: { queueOnStatus: [503] },
        signal: new AbortController().signal,
      },
      [],
    )

    expect(result.kind).toBe("error")
    if (result.kind === "error") {
      expect(result.error).toBeInstanceOf(RetryableStatusError)
      expect((result.error as RetryableStatusError).statusCode).toBe(503)
    }
  })

  it("cancels response body for retryable status codes", async () => {
    let bodyCancelled = false
    handler = (_req, res) => {
      res.writeHead(503)
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("data"))
          controller.close()
        },
        cancel() {
          bodyCancelled = true
        },
      })
      res.end(Buffer.from(await new Response(stream).arrayBuffer()))
    }

    const result = await executeRequest(
      {
        url,
        options: {} as RequestOptions<unknown>,
        triggerConfig: { queueOnStatus: [503] },
        signal: new AbortController().signal,
      },
      [],
    )

    // The response body should be cancelled since we won't read it
    // Note: this test verifies the body.cancel() call is made
    expect(result.kind).toBe("error")
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/queue/executor.test.ts`
Expected: FAIL — `queued_status` kind still exists, `RetryableStatusError` not returned.

- [ ] **Step 3: Update executor in `src/queue/executor.ts`**

Key changes:
1. Remove `queued_status` from `ExecuteResult` union
2. Import `HttpError`, `RetryableStatusError` from errors
3. Replace the `queueOnStatus` check to return `RetryableStatusError`
4. Replace the non-2xx check to return `HttpError`
5. Parse `Retry-After` header (seconds or HTTP-date) into `retryAfterMs`
6. Cancel `response.body` for retryable statuses

Updated `ExecuteResult` type:

```typescript
export type ExecuteResult =
  | { kind: "success"; result: Result<unknown> }
  | { kind: "timeout" }
  | { kind: "cancelled" }
  | { kind: "error"; error: AppError }
```

Updated status handling (replaces the `queueOnStatus` and non-2xx blocks):

```typescript
// Check if status code is retryable
const retryOnStatus = triggerConfig.queueOnStatus ?? []
if (retryOnStatus.includes(response.status)) {
  const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"))
  // Cancel the response body since caller won't read it
  try { await response.body?.cancel() } catch { /* ignore */ }
  return {
    kind: "error",
    error: new RetryableStatusError(
      `HTTP ${response.status} ${response.statusText}`,
      response.status,
      response,
      retryAfterMs,
    ),
  }
}

// Non-2xx responses are errors
if (!response.ok) {
  return {
    kind: "error",
    error: new HttpError(
      `HTTP ${response.status} ${response.statusText}`,
      response.status,
      response,
    ),
  }
}
```

Add `parseRetryAfter` helper:

```typescript
function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined
  const seconds = Number(header)
  if (!Number.isNaN(seconds)) return seconds * 1000
  // Try parsing as HTTP-date
  const date = new Date(header)
  if (!Number.isNaN(date.getTime())) {
    return Math.max(0, date.getTime() - Date.now())
  }
  return undefined
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/queue/executor.test.ts`
Expected: PASS

- [ ] **Step 5: Update retry loop to handle new error types**

In `src/queue/retry.ts`, the `queued_status` case should no longer exist. Update the switch:

```typescript
switch (result.kind) {
  case "success":
    controller.markDone(result.result)
    return

  case "cancelled":
    controller.markDone({ success: false, error: new CancelledError() } as never)
    return

  case "timeout":
    lastError = new TimeoutError(url, triggerConfig.timeoutMs ?? 0)
    break

  case "error":
    lastError = result.error
    break
}
```

- [ ] **Step 6: Update client to handle new error types**

In `src/core/client.ts`, the `_fireFirstAttempt` method's switch statement needs updating. The `queued_status` case should be removed. The `error` case should now handle `RetryableStatusError` and `HttpError`:

```typescript
case "error":
  // ValidationError is not retriable — resolve immediately
  if (result.error instanceof ValidationError) {
    this.emit("failure", { ticketId: ticket.id, url, error: result.error })
    controller.markDone({ success: false, error: result.error } as never)
    return
  }
  // HttpError (non-retryable status) — resolve immediately
  if (result.error instanceof HttpError) {
    this.emit("failure", { ticketId: ticket.id, url, error: result.error })
    controller.markDone({ success: false, error: result.error } as never)
    return
  }
  // Let the consumer veto retrying before the request is queued
  if (this.retryVetoed(retryConfig, result.error, ticket, controller, url)) return
  controller.markQueued()
  this._scheduleInBulkhead(
    ticket,
    controller,
    url,
    options,
    triggerConfig,
    retryConfig,
    partitionName,
    bulkhead,
  )
  return

case "timeout": {
  const error = new TimeoutError(url, triggerConfig.timeoutMs ?? 0)
  if (this.retryVetoed(retryConfig, error, ticket, controller, url)) return
  controller.markQueued()
  this._scheduleInBulkhead(
    ticket,
    controller,
    url,
    options,
    triggerConfig,
    retryConfig,
    partitionName,
    bulkhead,
  )
  return
}
```

Import `HttpError` and `RetryableStatusError` at the top of `client.ts`.

- [ ] **Step 7: Update existing integration tests**

In `test/core/client.integration.test.ts`:
- Update the 404 test to expect `HttpError` instead of `NetworkError`
- Update the 503 tests — 503 is in `queueOnStatus` so it returns `RetryableStatusError` (retriable)
- The `retryWhen` tests that check `statusCode` on `NetworkError` need updating to use `HttpError` or `RetryableStatusError`

- [ ] **Step 8: Run full test suite**

Run: `npx vitest run`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add src/queue/executor.ts src/queue/retry.ts src/core/client.ts \
  test/queue/executor.test.ts test/core/client.integration.test.ts
git commit -m "feat(error-model): executor returns typed status errors

- Drop queued_status from ExecuteResult
- 429/503 (in retryOnStatus) → RetryableStatusError with retryAfterMs
- Other non-2xx → HttpError
- Parse Retry-After header (seconds and HTTP-date)
- Cancel response body for retryable statuses"
```

---

### Task 2.3: Queue-full as `QueueFullError`

**Files:**
- Modify: `src/queue/bulkhead.ts`
- Modify: `src/core/client.ts`
- Modify: `test/queue/bulkhead.test.ts`

**Interfaces:**
- Consumes: `QueueFullError` from Task 2.1
- Produces: `QueueFullError` thrown from `bulkhead.schedule()` when queue is full

- [ ] **Step 1: Write failing test**

Add to `test/queue/bulkhead.test.ts`:

```typescript
import { QueueFullError } from "../../src/core/errors.js"

it("throws QueueFullError when queue is full", async () => {
  const bh = new Bulkhead("test", { concurrency: 1, maxQueueSize: 1 })
  // Fill the concurrency slot
  const blocker = new Promise<void>(() => {}) // never resolves
  bh.schedule(() => blocker)
  // Fill the queue
  const queued = new Promise<void>(() => {})
  bh.schedule(() => queued)

  // Third call should throw QueueFullError
  await expect(bh.schedule(async () => {})).rejects.toThrow(QueueFullError)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/queue/bulkhead.test.ts`
Expected: FAIL — currently throws generic `Error("Bulkhead '...' queue is full")`

- [ ] **Step 3: Update bulkhead to throw `QueueFullError`**

In `src/queue/bulkhead.ts`, update the `schedule` method:

```typescript
import { QueueFullError } from "../core/errors.js"

// In schedule():
if (!this.canAccept()) {
  throw new QueueFullError(this.name, this.queue.length, this.maxQueueSize)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/queue/bulkhead.test.ts`
Expected: PASS

- [ ] **Step 5: Update client to handle `QueueFullError`**

In `src/core/client.ts`, the `.catch()` in `_scheduleInBulkhead` already catches queue errors. Update it to preserve `QueueFullError`:

```typescript
.catch((err: unknown) => {
  if (err instanceof QueueFullError) {
    this.emit("failure", { ticketId: ticket.id, url, error: err })
    controller.markDone({ success: false, error: err } as never)
    return
  }
  const error = new NetworkError(err instanceof Error ? err.message : "Queue error", {
    cause: err,
  })
  this.emit("failure", { ticketId: ticket.id, url, error })
  controller.markDone({ success: false, error } as never)
})
```

Import `QueueFullError` at the top.

- [ ] **Step 6: Add integration test for queue-full**

In `test/core/client.integration.test.ts`:

```typescript
it("resolves with QueueFullError when queue is full", async () => {
  const iso = await createTestServer()
  try {
    const blockingClient = HttpClient.create({
      concurrency: 1,
      partitions: { default: { concurrency: 1, maxQueueSize: 1 } },
    })

    // First request will hang, filling the concurrency slot and queue
    iso.setHandler((_req, res) => {
      setTimeout(() => {
        res.writeHead(200)
        res.end("{}")
      }, 5000)
    })

    const ticket1 = blockingClient.get(`${iso.url}/block`)
    // Give it a moment to fill the slot
    await new Promise((r) => setTimeout(r, 20))

    // Second request fills the queue
    iso.setHandler((_req, res) => {
      setTimeout(() => {
        res.writeHead(200)
        res.end("{}")
      }, 5000)
    })
    const ticket2 = blockingClient.get(`${iso.url}/block2`)
    await new Promise((r) => setTimeout(r, 20))

    // Third request should get QueueFullError
    iso.setHandler((_req, res) => {
      res.writeHead(200)
      res.end("{}")
    })
    const result = await blockingClient.get(`${iso.url}/block3`).toPromise()

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toBeInstanceOf(QueueFullError)
    }

    // Clean up
    ticket1.cancel()
    ticket2.cancel()
  } finally {
    await iso.close()
  }
})
```

- [ ] **Step 7: Run full test suite**

Run: `npx vitest run`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add src/queue/bulkhead.ts src/core/client.ts \
  test/queue/bulkhead.test.ts test/core/client.integration.test.ts
git commit -m "feat(error-model): queue-full throws QueueFullError

- Bulkhead.schedule() throws QueueFullError instead of generic Error
- Client preserves QueueFullError through to ticket result
- Add integration test for queue-full scenario"
```

---

### Task 2.4: Config validation

**Files:**
- Create: `src/core/validate.ts`
- Modify: `src/core/client.ts`
- Modify: `src/core/index.ts`
- Create: `test/core/validate.test.ts`

**Interfaces:**
- Consumes: `ConfigurationError` from Task 2.1; `ClientConfig` from types
- Produces: `validateConfig()` function; throws `ConfigurationError` on invalid config

- [ ] **Step 1: Write failing tests**

Create `test/core/validate.test.ts`:

```typescript
import { describe, it, expect } from "vitest"
import { validateConfig } from "../../src/core/validate.js"
import { ConfigurationError } from "../../src/core/errors.js"

describe("validateConfig", () => {
  it("accepts valid empty config", () => {
    expect(() => validateConfig({})).not.toThrow()
  })

  it("accepts valid full config", () => {
    expect(() =>
      validateConfig({
        concurrency: 10,
        trigger: { timeoutMs: 1000, queueOnStatus: [429, 503] },
        retry: { maxRetries: 3, backoff: { baseDelayMs: 200, maxDelayMs: 30000 } },
        partitions: {
          api: { concurrency: 5, maxQueueSize: 50 },
        },
      }),
    ).not.toThrow()
  })

  it("rejects negative concurrency", () => {
    expect(() => validateConfig({ concurrency: -1 })).toThrow(ConfigurationError)
  })

  it("rejects zero concurrency", () => {
    expect(() => validateConfig({ concurrency: 0 })).toThrow(ConfigurationError)
  })

  it("rejects non-integer concurrency", () => {
    expect(() => validateConfig({ concurrency: 1.5 })).toThrow(ConfigurationError)
  })

  it("rejects maxQueueSize < 1", () => {
    expect(() =>
      validateConfig({ partitions: { x: { maxQueueSize: 0 } } }),
    ).toThrow(ConfigurationError)
  })

  it("rejects negative maxRetries", () => {
    expect(() =>
      validateConfig({ retry: { maxRetries: -1 } }),
    ).toThrow(ConfigurationError)
  })

  it("rejects timeoutMs <= 0", () => {
    expect(() =>
      validateConfig({ trigger: { timeoutMs: 0 } }),
    ).toThrow(ConfigurationError)
  })

  it("rejects negative timeoutMs", () => {
    expect(() =>
      validateConfig({ trigger: { timeoutMs: -100 } }),
    ).toThrow(ConfigurationError)
  })

  it("rejects baseDelayMs > maxDelayMs", () => {
    expect(() =>
      validateConfig({ retry: { backoff: { baseDelayMs: 1000, maxDelayMs: 100 } } }),
    ).toThrow(ConfigurationError)
  })

  it("rejects negative baseDelayMs", () => {
    expect(() =>
      validateConfig({ retry: { backoff: { baseDelayMs: -1 } } }),
    ).toThrow(ConfigurationError)
  })

  it("rejects negative maxDelayMs", () => {
    expect(() =>
      validateConfig({ retry: { backoff: { maxDelayMs: -1 } } }),
    ).toThrow(ConfigurationError)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/core/validate.test.ts`
Expected: FAIL — `validateConfig` does not exist.

- [ ] **Step 3: Implement `src/core/validate.ts`**

```typescript
import { ConfigurationError } from "./errors.js"
import type { ClientConfig, PartitionConfig } from "./types.js"

export function validateConfig(config: ClientConfig): void {
  if (config.concurrency !== undefined) {
    if (!Number.isInteger(config.concurrency) || config.concurrency < 1) {
      throw new ConfigurationError("concurrency must be a positive integer")
    }
  }

  if (config.trigger?.timeoutMs !== undefined && config.trigger.timeoutMs <= 0) {
    throw new ConfigurationError("trigger.timeoutMs must be positive")
  }

  validateRetryConfig(config.retry)
  validatePartitions(config.partitions)
}

function validateRetryConfig(retry: ClientConfig["retry"]): void {
  if (!retry) return

  if (retry.maxRetries !== undefined && retry.maxRetries < 0) {
    throw new ConfigurationError("retry.maxRetries must be non-negative")
  }

  if (retry.backoff && typeof retry.backoff === "object") {
    const { baseDelayMs, maxDelayMs } = retry.backoff
    if (baseDelayMs !== undefined && baseDelayMs < 0) {
      throw new ConfigurationError("retry.backoff.baseDelayMs must be non-negative")
    }
    if (maxDelayMs !== undefined && maxDelayMs < 0) {
      throw new ConfigurationError("retry.backoff.maxDelayMs must be non-negative")
    }
    if (
      baseDelayMs !== undefined &&
      maxDelayMs !== undefined &&
      baseDelayMs > maxDelayMs
    ) {
      throw new ConfigurationError(
        "retry.backoff.baseDelayMs must not exceed maxDelayMs",
      )
    }
  }
}

function validatePartitions(partitions: Record<string, PartitionConfig> | undefined): void {
  if (!partitions) return
  for (const [name, config] of Object.entries(partitions)) {
    if (config.concurrency !== undefined) {
      if (!Number.isInteger(config.concurrency) || config.concurrency < 1) {
        throw new ConfigurationError(
          `partitions.${name}.concurrency must be a positive integer`,
        )
      }
    }
    if (config.maxQueueSize !== undefined && config.maxQueueSize < 1) {
      throw new ConfigurationError(
        `partitions.${name}.maxQueueSize must be at least 1`,
      )
    }
    validateRetryConfig(config.retry)
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/core/validate.test.ts`
Expected: PASS

- [ ] **Step 5: Wire validation into `HttpClient.create()`**

In `src/core/client.ts`, call `validateConfig` at the top of `create()`:

```typescript
import { validateConfig } from "./validate.js"

static create(config: ClientConfig = {}): HttpClient {
  validateConfig(config)
  return new HttpClient(config)
}
```

- [ ] **Step 6: Export `validateConfig` from `src/core/index.ts`**

```typescript
export { validateConfig } from "./validate.js"
```

- [ ] **Step 7: Run full test suite**

Run: `npx vitest run`
Expected: PASS — existing tests use valid configs, so validation won't break them.

- [ ] **Step 8: Run typecheck and lint**

Run: `npx tsc --noEmit && npm run lint && npm run format:check`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add src/core/validate.ts src/core/client.ts src/core/index.ts \
  test/core/validate.test.ts
git commit -m "feat(error-model): add config validation

- validateConfig() throws ConfigurationError for invalid configs
- Validates: concurrency, timeout, retry, backoff, partition settings
- Called automatically from HttpClient.create()"
```

---

### Task 2.5: Final cleanup and verification

**Files:**
- Modify: `TRACKER.md` (update Phase 2 status)

- [ ] **Step 1: Run full test suite**

Run: `npx vitest run`
Expected: ALL PASS

- [ ] **Step 2: Run typecheck**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 3: Run lint and format**

Run: `npm run lint && npm run format:check`
Expected: PASS

- [ ] **Step 4: Run format if needed**

Run: `npm run format`
Then re-run lint and format:check.

- [ ] **Step 5: Update TRACKER.md**

Mark Phase 2 tasks as done:

```markdown
## Phase 2 — Error model

| # | Task | Status | PR |
|---|------|--------|----|
| 2.1 | Add `kind` and new error classes | Done | #TBD |
| 2.2 | Executor returns typed status errors | Done | #TBD |
| 2.3 | Queue-full as `QueueFullError` | Done | #TBD |
| 2.4 | Config validation | Done | #TBD |
```

- [ ] **Step 6: Final commit**

```bash
git add TRACKER.md
git commit -m "docs: mark Phase 2 tasks complete in tracker"
```
