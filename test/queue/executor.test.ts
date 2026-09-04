import { createServer, type Server, type ServerResponse } from "node:http"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { RequestOptions, RetryConfig, TimeoutConfig } from "../../src/core/types.js"
import { executeRequest } from "../../src/queue/executor.js"

/**
 * Pins the timeout-vs-external-abort precedence in executeRequest.
 *
 * Policy: the first abort source to fire wins; if both have fired by the
 * time the failure is classified, cancellation wins (the ticket is
 * already marked cancelled, and cancellation is the caller's terminal
 * intent). Each scenario uses wide timing margins so the winner is
 * deterministic.
 */
describe("executeRequest timeout/abort precedence", () => {
  let server: Server
  let url: string
  let handler: (res: ServerResponse) => void

  beforeAll(async () => {
    server = createServer((_req, res) => handler(res))
    await new Promise<void>((resolve) => server.listen(0, resolve))
    const addr = server.address()
    if (addr && typeof addr === "object") {
      url = `http://127.0.0.1:${addr.port}`
    }
  })

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve))
  })

  it("timeout firing first surfaces timeout, not cancelled", async () => {
    // Stall far longer than the timeout; no external signal involved.
    handler = (res) => {
      setTimeout(() => {
        try {
          res.writeHead(200)
          res.end("{}")
          // eslint-disable-next-line no-empty
        } catch {}
      }, 500)
    }

    const ticketController = new AbortController()
    const timeoutConfig: TimeoutConfig = { attemptMs: 30 }
    const retryConfig: RetryConfig = {}

    const result = await executeRequest(
      {
        url,
        options: {} as RequestOptions<unknown>,
        timeoutConfig,
        retryConfig,
        signal: ticketController.signal,
      },
      [],
    )

    expect(result.kind).toBe("timeout")
  }, 5_000)

  it("external abort firing first surfaces cancelled, not timeout", async () => {
    // Stall past both deadlines; the external abort lands well before
    // the timeout, so cancellation is the truthful classification.
    handler = (res) => {
      setTimeout(() => {
        try {
          res.writeHead(200)
          res.end("{}")
          // eslint-disable-next-line no-empty
        } catch {}
      }, 500)
    }

    const ticketController = new AbortController()
    const externalController = new AbortController()
    const timeoutConfig: TimeoutConfig = { attemptMs: 200 }
    const retryConfig: RetryConfig = {}
    setTimeout(() => externalController.abort(), 20)

    const result = await executeRequest(
      {
        url,
        options: { signal: externalController.signal } as RequestOptions<unknown>,
        timeoutConfig,
        retryConfig,
        signal: ticketController.signal,
      },
      [],
    )

    expect(result.kind).toBe("cancelled")
  }, 5_000)

  it("pre-aborted external signal takes precedence over a configured timeout", async () => {
    handler = (res) => {
      res.writeHead(200)
      res.end("{}")
    }

    const ticketController = new AbortController()
    const externalController = new AbortController()
    externalController.abort()
    const timeoutConfig: TimeoutConfig = { attemptMs: 50 }
    const retryConfig: RetryConfig = {}

    const result = await executeRequest(
      {
        url,
        options: { signal: externalController.signal } as RequestOptions<unknown>,
        timeoutConfig,
        retryConfig,
        signal: ticketController.signal,
      },
      [],
    )

    expect(result.kind).toBe("cancelled")
  })
})
