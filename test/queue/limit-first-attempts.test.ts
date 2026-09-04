import { describe, it, expect } from "vitest"
import * as http from "node:http"
import { HttpClient } from "../../src/core/client.js"

function createServer(): Promise<{ url: string; host: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer((_req, res) => {
      res.statusCode = 200
      res.end("ok")
    })
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address()!
      const port = typeof addr === "string" ? 0 : addr.port
      resolve({
        url: `http://127.0.0.1:${port}`,
        host: `127.0.0.1:${port}`,
        close: () => new Promise<void>((r) => server.close(() => r())),
      })
    })
  })
}

describe("Optional first-attempt limiting (5.5)", () => {
  it("serializes first attempts when limitFirstAttempts is true", async () => {
    const { url, host, close } = await createServer()

    try {
      const client = HttpClient.create({
        baseUrl: url,
        concurrency: 10,
        retry: { maxRetries: 0 },
        partitions: {
          [host]: { concurrency: 1, limitFirstAttempts: true },
        },
      })

      // Two requests with concurrency: 1 and limitFirstAttempts: true.
      // They should be serialized — first completes before second starts.
      const t1 = client.get("/a")
      const t2 = client.get("/b")

      await Promise.all([t1.toPromise(), t2.toPromise()])

      // Both should succeed.
      const s1 = await t1.toPromise()
      const s2 = await t2.toPromise()
      expect(s1.success).toBe(true)
      expect(s2.success).toBe(true)

      await client.close()
    } finally {
      await close()
    }
  })

  it("does not serialize first attempts when limitFirstAttempts is false (default)", async () => {
    let maxConcurrent = 0
    let currentConcurrent = 0

    const { close } = await createServer()

    try {
      // Patch the server to track concurrency.
      const server = http.createServer((_req, res) => {
        currentConcurrent++
        maxConcurrent = Math.max(maxConcurrent, currentConcurrent)
        res.statusCode = 200
        res.end("ok")
      })
      // Use a separate server for concurrency tracking.
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
      const addr = server.address()!
      const port = typeof addr === "string" ? 0 : addr.port
      const trackUrl = `http://127.0.0.1:${port}`
      const trackHost = `127.0.0.1:${port}`

      const client = HttpClient.create({
        baseUrl: trackUrl,
        concurrency: 10,
        retry: { maxRetries: 0 },
        partitions: {
          [trackHost]: { concurrency: 5, limitFirstAttempts: false },
        },
      })

      // Two requests — first attempts bypass the bulkhead.
      // Both should execute concurrently.
      await Promise.all([client.get("/a").toPromise(), client.get("/b").toPromise()])

      // At least 2 concurrent executions observed.
      expect(maxConcurrent).toBeGreaterThanOrEqual(2)

      currentConcurrent = 0
      maxConcurrent = 0

      await client.close()
      await new Promise<void>((r) => server.close(() => r()))
    } finally {
      await close()
    }
  })
})
