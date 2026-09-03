import { describe, it, expect } from "vitest"
import * as http from "node:http"
import { Semaphore } from "../../src/queue/semaphore.js"

function createServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer(handler)
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address()!
      const port = typeof addr === "string" ? 0 : addr.port
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>((r) => server.close(() => r())),
      })
    })
  })
}

describe("Global semaphore (5.2)", () => {
  it("limits total concurrent executions across partitions", async () => {
    // D1: concurrency (global, default 50) is a semaphore acquired inside
    // Bulkhead.run after the partition slot.
    // Acceptance: concurrency: 2, three partitions each with concurrency: 5,
    // 6 slow failing requests → never more than 2 in flight.

    let maxConcurrent = 0
    let currentConcurrent = 0

    const { url, close } = await createServer((_req, res) => {
      currentConcurrent++
      maxConcurrent = Math.max(maxConcurrent, currentConcurrent)
      // Slow response to keep requests in-flight
      setTimeout(() => {
        currentConcurrent--
        res.statusCode = 503
        res.end("unavailable")
      }, 100)
    })

    try {
      // Import HttpClient here to avoid circular dependency issues
      const { HttpClient } = await import("../../src/core/client.js")

      const client = HttpClient.create({
        baseUrl: url,
        concurrency: 2, // Global semaphore: max 2 across all partitions
        retry: {
          maxRetries: 0, // No retries — just fire once
        },
        partitions: {
          "127.0.0.1": { concurrency: 5 }, // Per-partition allows 5
        },
      })

      // Fire 6 requests across 3 different partitions
      await Promise.all([
        client.get("/a", { partition: "p1" }).toPromise(),
        client.get("/b", { partition: "p1" }).toPromise(),
        client.get("/c", { partition: "p2" }).toPromise(),
        client.get("/d", { partition: "p2" }).toPromise(),
        client.get("/e", { partition: "p3" }).toPromise(),
        client.get("/f", { partition: "p3" }).toPromise(),
      ])

      // Never more than 2 concurrent requests despite partitions allowing 5 each
      expect(maxConcurrent).toBeLessThanOrEqual(2)

      await client.close()
    } finally {
      await close()
    }
  })

  it("Semaphore acquires and releases permits", async () => {
    const sem = new Semaphore(2)

    const release1 = await sem.acquire()
    const release2 = await sem.acquire()

    // Both permits used — third should wait
    let acquired = false
    const p3 = sem.acquire().then((release) => {
      acquired = true
      return release
    })

    // Give microtask queue time to process
    await new Promise((r) => setTimeout(r, 10))
    expect(acquired).toBe(false) // Still waiting

    // Release one permit — third should now acquire
    release1()
    const release3 = await p3
    expect(acquired).toBe(true)

    // Clean up
    release2()
    release3()
  })

  it("Semaphore rejects when wait queue is full", async () => {
    const sem = new Semaphore(1, 0) // 1 permit, 0 wait queue

    const release1 = await sem.acquire()

    // Permit taken, wait queue full → should reject
    await expect(sem.acquire()).rejects.toThrow("full")

    release1()
  })
})
