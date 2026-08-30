import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { createServer, type ServerResponse } from "node:http"
import { HttpClient } from "../../src/core/client.js"
import {
  NetworkError,
  HttpError,
  RetryableStatusError,
  TimeoutError,
  ValidationError,
  MaxRetriesExceededError,
} from "../../src/core/errors.js"

describe("retry behavioral matrix", () => {
  let server: { url: string; close: () => Promise<void> }

  beforeAll(async () => {
    return new Promise<void>((resolve) => {
      server = createServer((_req, res) => {
        res.writeHead(503, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ error: "unavailable" }))
      })
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address() as { port: number }
        server.url = `http://127.0.0.1:${addr.port}`
        resolve()
      })
    })
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(resolve))
  })

  it("GET 503 with maxRetries:3 retries and eventually fails", async () => {
    // GET is idempotent, should be retried
    const client = HttpClient.create({
      retry: { maxRetries: 3 },
    })

    const ticket = client.get(server.url + "/test")
    const result = await ticket.toPromise()
    // GET 503 should be retried 3 times after the first attempt
    expect(result.success).toBe(false)
  })

  it("POST 503 with idempotent:false does NOT retry and resolves immediately", async () => {
    // POST without idempotent should NOT be retried
    const client = HttpClient.create({
      retry: { maxRetries: 3, idempotent: false },
    })

    const ticket = client.post(server.url + "/test")
    const result = await ticket.toPromise()
    // POST 503 without idempotent should NOT be retried
    expect(result.success).toBe(false)
  })

  it("POST 503 with idempotent:true DOES retry and eventually fails", async () => {
    // POST with idempotent should be retried
    const client = HttpClient.create({
      retry: { maxRetries: 3, idempotent: true },
    })

    const ticket = client.post(server.url + "/test")
    const result = await ticket.toPromise()
    // POST 503 with idempotent should be retried 3 times after the first attempt
    expect(result.success).toBe(false)
  })
})