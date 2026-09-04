import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { HttpClient } from "../../src/core/client.js"
import { redactUrl } from "../../src/core/redact.js"

interface TestServer {
  url: string
  close: () => Promise<void>
}

function createTestServer(): Promise<TestServer> {
  return new Promise((resolve) => {
    const server = createServer((_req: IncomingMessage, res: ServerResponse) => {
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end("{}")
    })
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number }
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        close: () => new Promise((r) => server.close(() => r())),
      })
    })
  })
}

describe("redactUrl", () => {
  it("returns URL without query string unchanged", () => {
    expect(redactUrl("https://example.com/path")).toBe("https://example.com/path")
  })

  it("redacts query parameter values", () => {
    expect(redactUrl("https://example.com/path?token=abc123")).toBe(
      "https://example.com/path?token=[redacted]",
    )
  })

  it("redacts multiple query parameter values", () => {
    expect(redactUrl("https://example.com/path?token=abc&user=joe")).toBe(
      "https://example.com/path?token=[redacted]&user=[redacted]",
    )
  })

  it("preserves bare keys without values", () => {
    expect(redactUrl("https://example.com/path?flag")).toBe("https://example.com/path?flag")
  })

  it("handles empty query string", () => {
    expect(redactUrl("https://example.com/path?")).toBe("https://example.com/path?")
  })

  it("handles complex URLs with fragments in query values", () => {
    // Fragment delimiter terminates the query string, so the fragment is preserved
    expect(redactUrl("https://example.com/path?token=abc#section")).toBe(
      "https://example.com/path?token=[redacted]#section",
    )
  })

  it("handles fragments after query string", () => {
    // Fragment delimiter terminates the query string in URL spec,
    // so q=1 is redacted but #section is preserved
    expect(redactUrl("https://example.com/path?q=1#section")).toBe(
      "https://example.com/path?q=[redacted]#section",
    )
  })
})

describe("Log redaction (6.3)", () => {
  let server: TestServer

  beforeAll(async () => {
    server = await createTestServer()
  })

  afterAll(async () => {
    await server.close()
  })

  it("redacts query parameters in lifecycle events by default", async () => {
    const client = HttpClient.create()
    const events: { url: string }[] = []

    client.on("success", (data) => {
      events.push({ url: data.url })
    })

    await client.get(`${server.url}/ok?token=secret123`).toPromise()

    expect(events.length).toBe(1)
    expect(events[0].url).not.toContain("secret123")
    expect(events[0].url).toContain("[redacted]")

    await client.close()
  })

  it("redacts query parameters in logger calls by default", async () => {
    const logs: { message: string; data: Record<string, unknown> }[] = []
    const logger = {
      info: (message: string, data: Record<string, unknown>) => {
        logs.push({ message, data })
      },
      warn: (message: string, data: Record<string, unknown>) => {
        logs.push({ message, data })
      },
      debug: (_message: string, _data: Record<string, unknown>) => {},
      error: (_message: string, _data: Record<string, unknown>) => {},
    }

    const client = HttpClient.create({ logger })

    await client.get(`${server.url}/ok?token=secret123`).toPromise()

    // Check that no log entry contains the raw secret
    const urlsInLogs = logs
      .filter((l) => typeof l.data?.url === "string")
      .map((l) => l.data.url as string)

    for (const url of urlsInLogs) {
      expect(url).not.toContain("secret123")
      expect(url).toContain("[redacted]")
    }

    await client.close()
  })

  it("preserves raw URLs in events when redactQuery is false", async () => {
    const client = HttpClient.create({ redactQuery: false })
    const events: { url: string }[] = []

    client.on("success", (data) => {
      events.push({ url: data.url })
    })

    await client.get(`${server.url}/ok?token=secret123`).toPromise()

    expect(events.length).toBe(1)
    expect(events[0].url).toContain("token=secret123")

    await client.close()
  })

  it("preserves raw URLs in logger when redactQuery is false", async () => {
    const logs: { message: string; data: Record<string, unknown> }[] = []
    const logger = {
      info: (message: string, data: Record<string, unknown>) => {
        logs.push({ message, data })
      },
      warn: (message: string, data: Record<string, unknown>) => {
        logs.push({ message, data })
      },
      debug: (_message: string, _data: Record<string, unknown>) => {},
      error: (_message: string, _data: Record<string, unknown>) => {},
    }

    const client = HttpClient.create({ logger, redactQuery: false })

    await client.get(`${server.url}/ok?token=secret123`).toPromise()

    const urlsInLogs = logs
      .filter((l) => typeof l.data?.url === "string")
      .map((l) => l.data.url as string)

    expect(urlsInLogs.some((u) => u.includes("token=secret123"))).toBe(true)

    await client.close()
  })

  it("redacts URLs in failure events on retry exhaustion", async () => {
    const client = HttpClient.create({
      retry: {
        maxRetries: 1,
        retryOnStatus: [503],
        backoff: { baseDelayMs: 10, jitter: false },
      },
    })
    const events: { kind: string; url: string }[] = []

    client.on("failure", (data) => {
      events.push({ kind: "failure", url: data.url })
    })

    // Use the server to return 503
    await server.close()
    const failServer = createServer((_req: IncomingMessage, res: ServerResponse) => {
      res.writeHead(503)
      res.end()
    })
    await new Promise<void>((r) => failServer.listen(0, "127.0.0.1", () => r()))
    const failAddr = failServer.address() as { port: number }
    const failUrl = `http://127.0.0.1:${failAddr}`

    await client.get(`${failUrl}/fail?apikey=supersecret`).toPromise()

    expect(events.length).toBe(1)
    expect(events[0].url).not.toContain("supersecret")
    expect(events[0].url).toContain("[redacted]")

    await client.close()
    await new Promise<void>((r) => failServer.close(() => r()))
  })
})
