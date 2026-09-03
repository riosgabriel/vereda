import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { getEventListeners } from "node:events"
import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { HttpClient } from "../../src/core/client.js"
import {
  CancelledError,
  ConfigurationError,
  DeadlineExceededError,
  HttpError,
  MaxRetriesExceededError,
  NetworkError,
  RetryableStatusError,
  TimeoutError,
  ValidationError,
} from "../../src/core/errors.js"
import { z } from "zod"
import { withZod } from "../../src/adapters/zod.js"

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

describe("HttpClient integration", () => {
  let server: TestServer
  let client: HttpClient

  beforeAll(async () => {
    server = await createTestServer()
    client = HttpClient.create({
      timeout: { attemptMs: 100 },
      retry: {
        maxRetries: 3,
        retryOnStatus: [429, 503],
        backoff: { baseDelayMs: 10, jitter: false },
      },
    })
  })

  afterAll(async () => {
    await server.close()
  })

  it("resolves immediately on fast successful response", async () => {
    server.setHandler((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end("{}")
    })
    const result = await client.get(`${server.url}/fast`).toPromise()
    expect(result.success).toBe(true)
  })

  it("validates response with Zod schema", async () => {
    const UserSchema = z.object({ id: z.number(), name: z.string() })
    server.setHandler((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ id: 1, name: "Alice" }))
    })
    const result = await client
      .get(`${server.url}/user`, { parse: withZod(UserSchema) })
      .toPromise()
    expect(result.success).toBe(true)
    if (result.success) expect(result.data).toEqual({ id: 1, name: "Alice" })
  })

  it("returns ValidationError immediately when schema doesn't match (no retry)", async () => {
    const UserSchema = z.object({ id: z.number(), name: z.string() })
    server.setHandler((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ id: "not-a-number", name: "Alice" }))
    })
    const result = await client
      .get(`${server.url}/user`, { parse: withZod(UserSchema) })
      .toPromise()
    expect(result.success).toBe(false)
    if (!result.success) expect(result.error).toBeInstanceOf(ValidationError)
  })

  it("queues and retries on 503, eventually fails with MaxRetriesExceededError", async () => {
    server.setHandler((_req, res) => {
      res.writeHead(503, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ error: "unavailable" }))
    })

    const ticket = client.get(`${server.url}/unavailable`)

    // Collect updates while waiting for result
    const updateTypes: string[] = []
    const [result] = await Promise.all([
      ticket.toPromise(),
      (async () => {
        for await (const u of ticket.subscribe()) {
          updateTypes.push(u.type)
        }
      })(),
    ])

    expect(result.success).toBe(false)
    if (!result.success) expect(result.error).toBeInstanceOf(MaxRetriesExceededError)
    expect(updateTypes).toContain("queued")
    expect(updateTypes).toContain("retrying")
    expect(updateTypes).toContain("done")
  }, 10_000)

  it("queues and retries on timeout, eventually fails", async () => {
    const hangingRequests: ServerResponse[] = []
    server.setHandler((_req, res) => {
      hangingRequests.push(res)
    })

    const slowClient = HttpClient.create({
      timeout: { attemptMs: 50 },
      retry: { maxRetries: 2, backoff: { baseDelayMs: 10, jitter: false } },
    })

    const result = await slowClient.get(`${server.url}/slow`).toPromise()
    // Clean up hanging server connections
    hangingRequests.forEach((res) => {
      try {
        res.destroy()
        // eslint-disable-next-line no-empty
      } catch {}
    })

    expect(result.success).toBe(false)
    if (!result.success) expect(result.error).toBeInstanceOf(MaxRetriesExceededError)
  }, 10_000)

  it("returns HttpError on non-2xx status (not in retryOnStatus)", async () => {
    server.setHandler((_req, res) => {
      res.writeHead(404)
      res.end("Not Found")
    })
    // 404 is not in retryOnStatus → HttpError, non-retryable → resolves immediately
    const noRetryClient = HttpClient.create({
      retry: { maxRetries: 1 },
    })
    const result = await noRetryClient.get(`${server.url}/missing`).toPromise()
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toBeInstanceOf(HttpError)
      expect((result.error as HttpError).statusCode).toBe(404)
    }
  })

  it("retryWhen predicate stops retrying and surfaces the underlying error", async () => {
    server.setHandler((_req, res) => {
      res.writeHead(429)
      res.end("rate limited")
    })

    const result = await client
      .get(`${server.url}/bad`, {
        retry: {
          maxRetries: 3,
          backoff: { baseDelayMs: 10, jitter: false },
          retryWhen: (err) => !(err instanceof RetryableStatusError && err.statusCode === 429),
        },
      })
      .toPromise()

    expect(result.success).toBe(false)
    if (!result.success) {
      // Should surface the RetryableStatusError, not MaxRetriesExceededError
      expect(result.error).toBeInstanceOf(RetryableStatusError)
      expect((result.error as RetryableStatusError).statusCode).toBe(429)
    }
  })

  it("retryWhen receives the failed attempt's zero-based number", async () => {
    const iso = await createTestServer()
    try {
      let requestCount = 0
      iso.setHandler((_req, res) => {
        requestCount++
        res.writeHead(429)
        res.end("rate limited")
      })

      const isoClient = HttpClient.create({
        retry: { maxRetries: 3, retryOnStatus: [429], backoff: { baseDelayMs: 10, jitter: false } },
      })

      const attemptsSeen: number[] = []
      const result = await isoClient
        .get(`${iso.url}/bad`, {
          retry: {
            maxRetries: 3,
            backoff: { baseDelayMs: 10, jitter: false },
            retryWhen: (_err, attempt) => {
              attemptsSeen.push(attempt)
              return attempt < 2
            },
          },
        })
        .toPromise()

      // retryVetoed passes 0, loop retries pass 1 then 2 (rejected)
      expect(attemptsSeen).toEqual([0, 1, 2])
      expect(requestCount).toBe(3)
      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error).toBeInstanceOf(RetryableStatusError)
        expect((result.error as RetryableStatusError).statusCode).toBe(429)
      }
    } finally {
      await iso.close()
    }
  })

  it("retryWhen rejecting the first failure prevents any retry", async () => {
    const iso = await createTestServer()
    try {
      let requestCount = 0
      iso.setHandler((_req, res) => {
        requestCount++
        res.writeHead(429)
        res.end("rate limited")
      })

      const isoClient = HttpClient.create({
        retry: { maxRetries: 3, retryOnStatus: [429], backoff: { baseDelayMs: 10, jitter: false } },
      })

      const result = await isoClient
        .get(`${iso.url}/bad`, {
          retry: {
            maxRetries: 3,
            backoff: { baseDelayMs: 10, jitter: false },
            retryWhen: () => false,
          },
        })
        .toPromise()

      expect(requestCount).toBe(1)
      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error).toBeInstanceOf(RetryableStatusError)
        expect((result.error as RetryableStatusError).statusCode).toBe(429)
      }
    } finally {
      await iso.close()
    }
  })

  it("cancel() aborts the ticket immediately", async () => {
    server.setHandler((_req, res) => {
      setTimeout(() => {
        try {
          res.writeHead(200)
          res.end("{}")
          // eslint-disable-next-line no-empty
        } catch {}
      }, 5000)
    })
    const ticket = client.get(`${server.url}/cancel-me`)
    setTimeout(() => ticket.cancel(), 20)
    const result = await ticket.toPromise()
    expect(result.success).toBe(false)
    if (!result.success) expect(result.error.constructor.name).toBe("CancelledError")
  }, 5_000)

  it("middleware pipeline modifies request headers", async () => {
    let receivedHeader = ""
    server.setHandler((req, res) => {
      receivedHeader = req.headers["x-custom"] as string
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end("{}")
    })
    const middlewareClient = HttpClient.create()
    middlewareClient.use(async (options, next) => {
      return next({ ...options, headers: { ...options.headers, "x-custom": "relay-test" } })
    })
    await middlewareClient.get(`${server.url}/headers`).toPromise()
    expect(receivedHeader).toBe("relay-test")
  })

  it("honors a pre-aborted external signal", async () => {
    let requestCount = 0
    server.setHandler((_req, res) => {
      requestCount++
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end("{}")
    })

    const controller = new AbortController()
    controller.abort()

    const ticket = client.get(`${server.url}/pre-aborted`, { signal: controller.signal })
    const result = await ticket.toPromise()

    expect(result.success).toBe(false)
    if (!result.success) expect(result.error).toBeInstanceOf(CancelledError)
    expect(requestCount).toBe(0)
    expect(ticket.isCancelled).toBe(true)
  })

  it("aborts an in-flight request via external signal", async () => {
    server.setHandler((_req, res) => {
      setTimeout(() => {
        try {
          res.writeHead(200)
          res.end("{}")
          // eslint-disable-next-line no-empty
        } catch {}
      }, 500)
    })

    const controller = new AbortController()
    const ticket = client.get(`${server.url}/in-flight-abort`, { signal: controller.signal })
    setTimeout(() => controller.abort(), 30)

    const result = await ticket.toPromise()

    expect(result.success).toBe(false)
    if (!result.success) expect(result.error).toBeInstanceOf(CancelledError)
    expect(ticket.isCancelled).toBe(true)
  }, 5_000)

  it("external abort during retry backoff stops retrying", async () => {
    let requestCount = 0
    server.setHandler((_req, res) => {
      requestCount++
      res.writeHead(429)
      res.end("rate limited")
    })

    const controller = new AbortController()
    const ticket = client.get(`${server.url}/backoff-abort`, {
      signal: controller.signal,
      retry: { maxRetries: 3, backoff: { baseDelayMs: 200, jitter: false } },
    })
    setTimeout(() => controller.abort(), 50)

    const result = await ticket.toPromise()

    expect(result.success).toBe(false)
    if (!result.success) expect(result.error).toBeInstanceOf(CancelledError)
    // 429 is retryable → queues for retry with 200ms backoff. The abort
    // fires ~50 ms after the first request, during the backoff, so the
    // retry never fires: only 1 request total.
    expect(requestCount).toBe(1)
  }, 5_000)

  it("resolves relative URL without baseUrl as a ticket error", async () => {
    const clientNoBase = HttpClient.create()
    const ticket = clientNoBase.get("/relative")
    const result = await ticket.toPromise()

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toBeInstanceOf(NetworkError)
    }
    // Should not throw — the error is on the ticket, not in the call
  })

  it('emits "retry" event for every retry with increasing attempt on repeated 503', async () => {
    const maxRetries = 4
    server.setHandler((_req, res) => {
      res.writeHead(503, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ error: "unavailable" }))
    })

    const retryClient = HttpClient.create({
      retry: { maxRetries, retryOnStatus: [503], backoff: { baseDelayMs: 10, jitter: false } },
    })

    const retryEvents: { attempt: number; delayMs: number }[] = []
    retryClient.on("retry", (data) => {
      retryEvents.push({ attempt: data.attempt, delayMs: data.delayMs })
    })

    const result = await retryClient.get(`${server.url}/retry-event`).toPromise()

    expect(result.success).toBe(false)
    // maxRetries = 4 → 4 retries → 4 retry events (one per loop iteration)
    expect(retryEvents).toHaveLength(maxRetries)
    // Zero-based retry index: 0, 1, 2, 3
    expect(retryEvents.map((e) => e.attempt)).toEqual([0, 1, 2, 3])
    // All delays should be positive
    for (const event of retryEvents) {
      expect(event.delayMs).toBeGreaterThan(0)
    }
  }, 10_000)

  it("first retry gets backoff and retrying update", async () => {
    const requestTimestamps: number[] = []
    server.setHandler((_req, res) => {
      requestTimestamps.push(Date.now())
      res.writeHead(503, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ error: "unavailable" }))
    })

    const retryClient = HttpClient.create({
      retry: { maxRetries: 1, retryOnStatus: [503], backoff: { baseDelayMs: 50, jitter: false } },
    })

    const ticket = retryClient.get(`${server.url}/backoff-test`)
    const updateTypes: string[] = []
    const [result] = await Promise.all([
      ticket.toPromise(),
      (async () => {
        for await (const u of ticket.subscribe()) {
          updateTypes.push(u.type)
        }
      })(),
    ])

    expect(result.success).toBe(false)
    // maxRetries: 1 → first attempt + 1 retry → 2 server hits
    expect(requestTimestamps).toHaveLength(2)
    // Second hit arrives ≥ 45 ms after the first (backoff: 50 ms, no jitter)
    expect(requestTimestamps[1] - requestTimestamps[0]).toBeGreaterThanOrEqual(45)
    // Ticket updates: queued, retrying, done
    expect(updateTypes).toEqual(["queued", "retrying", "done"])
  }, 10_000)

  it("removes external-signal abort listener after ticket resolves (#7)", async () => {
    server.setHandler((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end("{}")
    })

    const controller = new AbortController()
    const listenersBefore = getEventListeners(controller.signal, "abort").length

    const ticket = client.get(`${server.url}/signal-cleanup`, { signal: controller.signal })
    const result = await ticket.toPromise()

    expect(result.success).toBe(true)

    // The external signal's abort listener count should return to its
    // pre-request value after the ticket resolves.
    const listenersAfter = getEventListeners(controller.signal, "abort").length
    expect(listenersAfter).toBe(listenersBefore)
  })

  it("removes external-signal listener after ticket with retries resolves (#7)", async () => {
    let attempts = 0
    server.setHandler((_req, res) => {
      attempts++
      if (attempts < 3) {
        res.writeHead(503)
        res.end("unavailable")
      } else {
        res.writeHead(200, { "Content-Type": "application/json" })
        res.end("{}")
      }
    })

    const controller = new AbortController()
    const listenersBefore = getEventListeners(controller.signal, "abort").length

    const retryClient = HttpClient.create({
      retry: { maxRetries: 3, backoff: { baseDelayMs: 10, jitter: false } },
    })

    const ticket = retryClient.get(`${server.url}/signal-cleanup-retry`, {
      signal: controller.signal,
      retry: { retryOnStatus: [503] },
    })
    const result = await ticket.toPromise()

    expect(result.success).toBe(true)

    const listenersAfter = getEventListeners(controller.signal, "abort").length
    expect(listenersAfter).toBe(listenersBefore)
  })

  it("removes external-signal listener after cancellation (#7)", async () => {
    server.setHandler((_req, res) => {
      setTimeout(() => {
        try {
          res.writeHead(200)
          res.end("{}")
          // eslint-disable-next-line no-empty
        } catch {}
      }, 5000)
    })
    const controller = new AbortController()
    const listenersBefore = getEventListeners(controller.signal, "abort").length

    const ticket = client.get(`${server.url}/signal-cleanup-cancel`, { signal: controller.signal })
    setTimeout(() => controller.abort(), 20)
    await ticket.toPromise()

    const listenersAfter = getEventListeners(controller.signal, "abort").length
    expect(listenersAfter).toBe(listenersBefore)
  })

  it("per-attempt timeout covers body read, not just headers (#9)", async () => {
    // Server sends 200 headers immediately but delays the body by 500ms.
    // With attemptMs: 100 and a parse fn, the ticket should resolve with
    // TimeoutError once the body read exceeds the deadline.
    server.setHandler((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" })
      // Delay the body — headers are sent immediately
      setTimeout(() => {
        try {
          res.end(JSON.stringify({ ok: true }))
          // eslint-disable-next-line no-empty
        } catch {}
      }, 500)
    })

    const start = Date.now()
    const ticket = client.get(`${server.url}/slow-body`, {
      timeout: { attemptMs: 100 },
      retry: { maxRetries: 0 },
      parse: (data) => data as { ok: boolean },
    })
    const result = await ticket.toPromise()
    const elapsed = Date.now() - start

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toBeInstanceOf(TimeoutError)
    }
    // Should resolve well within 300ms (100ms timeout + tolerance)
    expect(elapsed).toBeLessThan(300)
  }, 5_000)

  it("total deadline during active request resolves with DeadlineExceededError", async () => {
    // Server delays response body beyond deadline. The deadline should fire
    // while the request is in-flight and resolve with DeadlineExceededError.
    server.setHandler((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" })
      setTimeout(() => {
        try {
          res.end(JSON.stringify({ ok: true }))
          // eslint-disable-next-line no-empty
        } catch {}
      }, 2000)
    })

    const start = Date.now()
    const ticket = client.get(`${server.url}/slow-body`, {
      timeout: { totalMs: 100 },
      retry: { maxRetries: 0 },
    })
    const result = await ticket.toPromise()
    const elapsed = Date.now() - start

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toBeInstanceOf(DeadlineExceededError)
    }
    // Should resolve near the deadline
    expect(elapsed).toBeGreaterThanOrEqual(80)
    expect(elapsed).toBeLessThan(300)
  }, 5_000)

  it("total deadline cancels ticket and resolves with DeadlineExceededError (#R3)", async () => {
    // Server always returns 503. With totalMs: 300 and baseDelayMs: 100,
    // the deadline should fire during a retry backoff (between 2nd and 3rd attempt)
    // and resolve with DeadlineExceededError between 300–400ms.
    server.setHandler((_req, res) => {
      res.writeHead(503, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ error: "unavailable" }))
    })

    const start = Date.now()
    const ticket = client.get(`${server.url}/always-503`, {
      timeout: { totalMs: 300 },
      retry: { maxRetries: 10, backoff: { baseDelayMs: 100, jitter: false } },
    })
    const result = await ticket.toPromise()
    const elapsed = Date.now() - start

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toBeInstanceOf(DeadlineExceededError)
      if (result.error instanceof DeadlineExceededError) {
        expect(result.error.totalMs).toBe(300)
      }
    }
    // Should resolve within the deadline window + tolerance
    expect(elapsed).toBeGreaterThanOrEqual(280)
    expect(elapsed).toBeLessThan(500)
  }, 5_000)

  describe("graceful shutdown (O4)", () => {
    it("rejects new requests after close({ drain: false })", async () => {
      const client = HttpClient.create()
      client.close({ drain: false })

      expect(() => client.get(`${server.url}/test`)).toThrow(ConfigurationError)
      expect(() => client.get(`${server.url}/test`)).toThrow("client closed")
    })

    it("close({ drain: false }) cancels in-flight tickets", async () => {
      let resolveRequest: (() => void) | undefined
      server.setHandler((_req, res) => {
        new Promise<void>((r) => {
          resolveRequest = r
        }).then(() => {
          res.writeHead(200, { "Content-Type": "application/json" })
          res.end(JSON.stringify({ ok: true }))
        })
      })

      const client = HttpClient.create()
      const ticket = client.get(`${server.url}/slow`, {
        retry: { maxRetries: 0 },
      })

      // Wait for the request to be in-flight
      await new Promise((r) => setTimeout(r, 50))

      const closePromise = client.close({ drain: false })

      // Resolve the server handler so it doesn't hang
      resolveRequest?.()

      await closePromise
      const result = await ticket.toPromise()
      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error).toBeInstanceOf(CancelledError)
      }
    })

    it("close({ drain: true }) waits for in-flight requests", async () => {
      server.setHandler((_req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ ok: true }))
      })

      const client = HttpClient.create()
      const ticket = client.get(`${server.url}/fast`, {
        retry: { maxRetries: 0 },
      })

      // Wait for the request to be in-flight
      await new Promise((r) => setTimeout(r, 50))

      await client.close({ drain: true, timeoutMs: 5_000 })
      const result = await ticket.toPromise()
      expect(result.success).toBe(true)
    })

    it("close({ drain: true, timeoutMs }) cancels after timeout", async () => {
      let resolveRequest: (() => void) | undefined
      server.setHandler((_req, res) => {
        new Promise<void>((r) => {
          resolveRequest = r
        }).then(() => {
          res.writeHead(200, { "Content-Type": "application/json" })
          res.end(JSON.stringify({ ok: true }))
        })
      })

      const client = HttpClient.create()
      const ticket = client.get(`${server.url}/slow`, {
        retry: { maxRetries: 0 },
      })

      // Wait for the request to be in-flight
      await new Promise((r) => setTimeout(r, 50))

      await client.close({ drain: true, timeoutMs: 100 })

      // Resolve the server handler so it doesn't hang
      resolveRequest?.()

      const result = await ticket.toPromise()
      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error).toBeInstanceOf(CancelledError)
      }
    })

    it("close is idempotent", async () => {
      const client = HttpClient.create()
      await client.close({ drain: false })
      await client.close({ drain: false }) // should not throw
    })

    it("process exits promptly after close({ drain: false }) with sleeping retry", async () => {
      // Server always fails, triggering retries with backoff
      server.setHandler((_req, res) => {
        res.writeHead(503, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ error: "unavailable" }))
      })

      const client = HttpClient.create()
      const ticket = client.get(`${server.url}/always-503`, {
        retry: { maxRetries: 5, backoff: { baseDelayMs: 1000, jitter: false } },
      })

      // Wait for the first attempt to complete and retry to start sleeping
      await new Promise((r) => setTimeout(r, 50))

      const start = Date.now()
      await client.close({ drain: false })
      const elapsed = Date.now() - start

      // Should exit quickly, not wait for the 1s backoff
      expect(elapsed).toBeLessThan(200)

      const result = await ticket.toPromise()
      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error).toBeInstanceOf(CancelledError)
      }
    })
  })
})
