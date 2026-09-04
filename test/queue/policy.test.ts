import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { HttpClient } from "../../src/core/client.js"
import {
  type AppError,
  CancelledError,
  ConfigurationError,
  HttpError,
  MaxRetriesExceededError,
  NetworkError,
  QueueFullError,
  RetryableStatusError,
  TimeoutError,
  ValidationError,
} from "../../src/core/errors.js"
import { defaultRetryPolicy, shouldRetry } from "../../src/queue/policy.js"

interface TestServer {
  url: string
  close: () => Promise<void>
  setHandler: (fn: (req: IncomingMessage, res: ServerResponse) => void) => void
}

function createTestServer(): Promise<TestServer> {
  return new Promise((resolve) => {
    let handler: (req: IncomingMessage, res: ServerResponse) => void = (_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ ok: true }))
    }
    const server = createServer((req, res) => handler(req, res))
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number }
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        close: () => new Promise((r) => server.close(() => r())),
        setHandler: (fn) => {
          handler = fn
        },
      })
    })
  })
}

const retriableCtx = { method: "GET" }

describe("defaultRetryPolicy", () => {
  it("retries retriable kinds for an idempotent method", () => {
    const cases: [AppError, boolean][] = [
      [new NetworkError("fail"), true],
      [new TimeoutError("http://x", 100), true],
      [new RetryableStatusError("busy", 500, new Response()), true],
    ]
    for (const [error, expected] of cases) {
      expect(defaultRetryPolicy(error, 0, retriableCtx)).toBe(expected)
    }
  })

  it("does not retry non-retriable kinds", () => {
    const cases: [AppError, boolean][] = [
      [new HttpError("not found", 404, new Response()), false],
      [new ValidationError("bad", []), false],
      [new CancelledError(), false],
      [new QueueFullError("a", 1, 1), false],
      [new ConfigurationError("retry"), false],
      [new MaxRetriesExceededError(1, new NetworkError("fail")), false],
    ]
    for (const [error, expected] of cases) {
      expect(defaultRetryPolicy(error, 0, retriableCtx)).toBe(expected)
    }
  })

  it("does not retry a non-idempotent method without opt-in", () => {
    const err = new RetryableStatusError("busy", 500, new Response())
    expect(defaultRetryPolicy(err, 0, { method: "POST" })).toBe(false)
    expect(defaultRetryPolicy(err, 0, { method: "PATCH" })).toBe(false)
    expect(defaultRetryPolicy(err, 0, { method: "CONNECT" })).toBe(false)
  })

  it("retries a non-idempotent method when idempotent is true", () => {
    const err = new RetryableStatusError("busy", 500, new Response())
    expect(defaultRetryPolicy(err, 0, { method: "POST", idempotent: true })).toBe(true)
  })

  it("honors an Idempotency-Key header case-insensitively", () => {
    const err = new RetryableStatusError("busy", 500, new Response())
    expect(
      defaultRetryPolicy(err, 0, { method: "POST", headers: { "idempotency-key": "abc" } }),
    ).toBe(true)
    expect(
      defaultRetryPolicy(err, 0, { method: "POST", headers: { "Idempotency-Key": "abc" } }),
    ).toBe(true)
  })

  it("normalizes the method to uppercase", () => {
    const err = new RetryableStatusError("busy", 500, new Response())
    expect(defaultRetryPolicy(err, 0, { method: "get" })).toBe(true)
  })

  it("shouldRetry lets retryWhen veto after the default policy passes", () => {
    const err = new RetryableStatusError("busy", 500, new Response())
    expect(shouldRetry(err, 0, retriableCtx, () => false)).toBe(false)
    expect(shouldRetry(err, 0, retriableCtx, () => true)).toBe(true)
    expect(shouldRetry(err, 0, retriableCtx)).toBe(true)
  })

  it("shouldRetry cannot force a retry that the default policy vetoes", () => {
    const err = new HttpError("not found", 404, new Response())
    expect(shouldRetry(err, 0, retriableCtx, () => true)).toBe(false)
  })
})

describe("idempotency gate (integration)", () => {
  let server: TestServer

  beforeAll(async () => {
    server = await createTestServer()
  })

  afterAll(async () => {
    await server.close()
  })

  const fastRetry = { backoff: { baseDelayMs: 10, jitter: false } }

  function serve500() {
    let hits = 0
    server.setHandler((_req, res) => {
      hits++
      res.writeHead(500)
      res.end("server error")
    })
    return () => hits
  }

  it("POST 500 → exactly 1 request, raw RetryableStatusError", async () => {
    const getHits = serve500()
    const client = HttpClient.create({ retry: fastRetry })
    const result = await client.post(`${server.url}/post`).toPromise()

    expect(getHits()).toBe(1)
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toBeInstanceOf(RetryableStatusError)
      expect(result.error).not.toBeInstanceOf(MaxRetriesExceededError)
    }
  })

  it("POST 500 with retry.idempotent → 4 requests, MaxRetriesExceededError attempts=4", async () => {
    const getHits = serve500()
    const client = HttpClient.create()
    const result = await client
      .post(`${server.url}/post-idempotent`, undefined, {
        retry: { ...fastRetry, idempotent: true },
      })
      .toPromise()

    expect(getHits()).toBe(4)
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toBeInstanceOf(MaxRetriesExceededError)
      expect((result.error as MaxRetriesExceededError).attempts).toBe(4)
    }
  }, 10_000)

  it("POST 500 with Idempotency-Key header → 4 requests", async () => {
    const getHits = serve500()
    const client = HttpClient.create()
    const result = await client
      .post(`${server.url}/post-key`, undefined, {
        headers: { "Idempotency-Key": "abc-123" },
        retry: fastRetry,
      })
      .toPromise()

    expect(getHits()).toBe(4)
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toBeInstanceOf(MaxRetriesExceededError)
      expect((result.error as MaxRetriesExceededError).attempts).toBe(4)
    }
  }, 10_000)

  it("GET 500 → 4 requests", async () => {
    const getHits = serve500()
    const client = HttpClient.create()
    const result = await client.get(`${server.url}/get`, { retry: fastRetry }).toPromise()

    expect(getHits()).toBe(4)
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toBeInstanceOf(MaxRetriesExceededError)
      expect((result.error as MaxRetriesExceededError).attempts).toBe(4)
    }
  }, 10_000)

  it("GET 500 with retryWhen: () => false → 1 request", async () => {
    const getHits = serve500()
    const client = HttpClient.create()
    const result = await client
      .get(`${server.url}/get-veto`, { retry: { ...fastRetry, retryWhen: () => false } })
      .toPromise()

    expect(getHits()).toBe(1)
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toBeInstanceOf(RetryableStatusError)
      expect(result.error).not.toBeInstanceOf(MaxRetriesExceededError)
    }
  })
})
