import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { describe, it, expect, beforeAll, afterAll } from "vitest"
import {
  HttpClient,
  MaxRetriesExceededError,
  RetryableStatusError,
  HttpError,
  ValidationError,
  NetworkError,
} from "../../src/core/index.js"

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

/** Readable name → real error.kind. MaxRetriesExceededError.kind is "max_retries". */
const TERMINAL_KIND: Record<string, string> = {
  max_retries_exceeded: "max_retries",
  network: "network",
  http: "http",
  validation: "validation",
  retryable_status: "retryable_status",
}

/** Response mode: destroy the socket (network error), return a status code, or
 *  return a body that fails the request's parse function. */
type Mode = "destroy" | number | "validation"

interface Row {
  method: string
  mode: Mode
  idempotent?: boolean
  maxRetries?: number
  headers?: Record<string, string>
  parse?: (data: unknown) => unknown
  expectedRequests: number
  expectedKind: string
}

// A: Q4 method set over a network error (socket destroyed).
// CONNECT is classified non-idempotent at the policy level but undici fetch
// forbids issuing it, so it's covered in test/queue/policy.test.ts unit tests.
// TRACE is likewise forbidden by undici (a forbidden method per the Fetch
// spec) — it fails client-side before reaching the server (0 hits), but the
// retry policy still classifies it as idempotent, so all 3 attempts run.
const networkRows: Row[] = ["GET", "HEAD", "OPTIONS", "PUT", "DELETE"].map((method) => ({
  method,
  mode: "destroy" as Mode,
  expectedRequests: 3,
  expectedKind: "max_retries_exceeded",
}))
networkRows.push({
  method: "TRACE",
  mode: "destroy",
  expectedRequests: 0,
  expectedKind: "max_retries_exceeded",
})
for (const method of ["POST", "PATCH"]) {
  networkRows.push({ method, mode: "destroy", expectedRequests: 1, expectedKind: "network" })
}

// B: GET and POST × error mode × idempotent flag.
const statusModes = [408, 429, 500, 404]
const throwingParse = () => {
  throw new Error("invalid data")
}
const getRows: Row[] = []
for (const idempotent of [false, true]) {
  for (const mode of statusModes) {
    getRows.push({
      method: "GET",
      mode,
      idempotent,
      expectedRequests: mode === 404 ? 1 : 3,
      expectedKind: mode === 404 ? "http" : "max_retries_exceeded",
    })
  }
  getRows.push({
    method: "GET",
    mode: "validation",
    idempotent,
    parse: throwingParse,
    expectedRequests: 1,
    expectedKind: "validation",
  })
}
const postRows: Row[] = []
for (const idempotent of [false, true]) {
  for (const mode of statusModes) {
    postRows.push({
      method: "POST",
      mode,
      idempotent,
      expectedRequests: mode === 404 || !idempotent ? 1 : 3,
      expectedKind:
        mode === 404 ? "http" : idempotent ? "max_retries_exceeded" : "retryable_status",
    })
  }
  postRows.push({
    method: "POST",
    mode: "validation",
    idempotent,
    parse: throwingParse,
    expectedRequests: 1,
    expectedKind: "validation",
  })
}

// C: Idempotency-Key equivalence — POST + header, flag off.
const idempotencyKeyRows: Row[] = [
  {
    method: "POST",
    mode: 429,
    headers: { "Idempotency-Key": "abc" },
    expectedRequests: 3,
    expectedKind: "max_retries_exceeded",
  },
]

// D: maxRetries: 0 — the raw error is resolved unwrapped.
const maxRetriesZeroRows: Row[] = [
  {
    method: "GET",
    mode: 429,
    maxRetries: 0,
    expectedRequests: 1,
    expectedKind: "retryable_status",
  },
  { method: "GET", mode: 404, maxRetries: 0, expectedRequests: 1, expectedKind: "http" },
]

const rows: Row[] = [
  ...networkRows,
  ...getRows,
  ...postRows,
  ...idempotencyKeyRows,
  ...maxRetriesZeroRows,
]

describe("retry behavior matrix", () => {
  let server: TestServer
  let client: HttpClient

  beforeAll(async () => {
    server = await createTestServer()
    client = HttpClient.create()
  })

  afterAll(async () => {
    await server.close()
  })

  it.each(rows)(
    "$method $mode idempotent=$idempotent → $expectedRequests requests, $expectedKind",
    async (row) => {
      let hits = 0
      server.setHandler((req, res) => {
        hits++
        if (row.mode === "destroy") {
          req.socket.destroy()
          return
        }
        if (row.mode === "validation") {
          res.writeHead(200, { "Content-Type": "application/json" })
          res.end("{}")
          return
        }
        res.writeHead(row.mode)
        res.end("error")
      })

      const retry = {
        backoff: { baseDelayMs: 10, jitter: false },
        idempotent: row.idempotent ?? false,
        maxRetries: row.maxRetries ?? 2,
      }
      const result = await client
        .request(`${server.url}/matrix`, {
          method: row.method,
          retry,
          headers: row.headers,
          parse: row.parse,
        })
        .toPromise()

      expect(hits).toBe(row.expectedRequests)
      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error.kind).toBe(TERMINAL_KIND[row.expectedKind])
        // Cross-check the kind maps to the expected class.
        switch (row.expectedKind) {
          case "max_retries_exceeded":
            expect(result.error).toBeInstanceOf(MaxRetriesExceededError)
            // 1 first attempt + maxRetries retries (3 for maxRetries: 2).
            expect((result.error as MaxRetriesExceededError).attempts).toBe(
              (row.maxRetries ?? 2) + 1,
            )
            break
          case "retryable_status":
            expect(result.error).toBeInstanceOf(RetryableStatusError)
            break
          case "http":
            expect(result.error).toBeInstanceOf(HttpError)
            break
          case "validation":
            expect(result.error).toBeInstanceOf(ValidationError)
            break
          case "network":
            expect(result.error).toBeInstanceOf(NetworkError)
            break
        }
      }
    },
  )

  it("maxRetries: 0 resolves the raw RetryableStatusError, unwrapped", async () => {
    let hits = 0
    server.setHandler((_req, res) => {
      hits++
      res.writeHead(429)
      res.end("too many")
    })

    const result = await client
      .request(`${server.url}/zero-429`, {
        method: "GET",
        retry: { maxRetries: 0, backoff: { baseDelayMs: 10, jitter: false } },
      })
      .toPromise()

    expect(hits).toBe(1)
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toBeInstanceOf(RetryableStatusError)
      expect(result.error.kind).toBe("retryable_status")
      expect(result.error).not.toBeInstanceOf(MaxRetriesExceededError)
    }
  })

  it("maxRetries: 0 resolves the raw HttpError, unwrapped", async () => {
    let hits = 0
    server.setHandler((_req, res) => {
      hits++
      res.writeHead(404)
      res.end("missing")
    })

    const result = await client
      .request(`${server.url}/zero-404`, {
        method: "GET",
        retry: { maxRetries: 0, backoff: { baseDelayMs: 10, jitter: false } },
      })
      .toPromise()

    expect(hits).toBe(1)
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toBeInstanceOf(HttpError)
      expect(result.error.kind).toBe("http")
      expect(result.error).not.toBeInstanceOf(MaxRetriesExceededError)
    }
  })
})
