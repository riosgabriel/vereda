import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { HttpClient } from "../../src/core/client.js";
import { MaxRetriesExceededError, NetworkError, ValidationError } from "../../src/core/errors.js";
import { z } from "zod";
import { withZod } from "../../src/adapters/zod.js";

interface TestServer {
  url: string;
  close: () => Promise<void>;
  setHandler: (fn: (req: IncomingMessage, res: ServerResponse) => void) => void;
}

function createTestServer(): Promise<TestServer> {
  return new Promise((resolve) => {
    let handler: (req: IncomingMessage, res: ServerResponse) => void = (_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    };
    const server = createServer((req, res) => handler(req, res));
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        close: () => new Promise((r) => server.close(() => r())),
        setHandler: (fn) => { handler = fn; },
      });
    });
  });
}

describe("HttpClient integration", () => {
  let server: TestServer;
  let client: HttpClient;

  beforeAll(async () => {
    server = await createTestServer();
    client = HttpClient.create({
      trigger: { timeoutMs: 100, queueOnStatus: [429, 503] },
      retry: { maxAttempts: 3, backoff: { baseDelayMs: 10, jitter: false } },
    });
  });

  afterAll(async () => { await server.close(); });

  it("resolves immediately on fast successful response", async () => {
    server.setHandler((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{}");
    });
    const result = await client.get(`${server.url}/fast`).toPromise();
    expect(result.success).toBe(true);
  });

  it("validates response with Zod schema", async () => {
    const UserSchema = z.object({ id: z.number(), name: z.string() });
    server.setHandler((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ id: 1, name: "Alice" }));
    });
    const result = await client.get(`${server.url}/user`, { parse: withZod(UserSchema) }).toPromise();
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toEqual({ id: 1, name: "Alice" });
  });

  it("returns ValidationError immediately when schema doesn't match (no retry)", async () => {
    const UserSchema = z.object({ id: z.number(), name: z.string() });
    server.setHandler((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ id: "not-a-number", name: "Alice" }));
    });
    const result = await client.get(`${server.url}/user`, { parse: withZod(UserSchema) }).toPromise();
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toBeInstanceOf(ValidationError);
  });

  it("queues and retries on 503, eventually fails with MaxRetriesExceededError", async () => {
    server.setHandler((_req, res) => {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "unavailable" }));
    });

    const ticket = client.get(`${server.url}/unavailable`);

    // Collect updates while waiting for result
    const updateTypes: string[] = [];
    const [result] = await Promise.all([
      ticket.toPromise(),
      (async () => {
        for await (const u of ticket.subscribe()) {
          updateTypes.push(u.type);
        }
      })(),
    ]);

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toBeInstanceOf(MaxRetriesExceededError);
    expect(updateTypes).toContain("queued");
    expect(updateTypes).toContain("retrying");
    expect(updateTypes).toContain("done");
  }, 10_000);

  it("queues and retries on timeout, eventually fails", async () => {
    const hangingRequests: ServerResponse[] = [];
    server.setHandler((_req, res) => { hangingRequests.push(res); });

    const slowClient = HttpClient.create({
      trigger: { timeoutMs: 50 },
      retry: { maxAttempts: 2, backoff: { baseDelayMs: 10, jitter: false } },
    });

    const result = await slowClient.get(`${server.url}/slow`).toPromise();
    // Clean up hanging server connections
    hangingRequests.forEach((res) => { try { res.destroy(); } catch {} });

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toBeInstanceOf(MaxRetriesExceededError);
  }, 10_000);

  it("returns NetworkError on non-2xx status (not in queueOnStatus)", async () => {
    server.setHandler((_req, res) => {
      res.writeHead(404);
      res.end("Not Found");
    });
    // Use a client with no retry on errors to get immediate result
    const noRetryClient = HttpClient.create({
      retry: { maxAttempts: 1 },
    });
    const result = await noRetryClient.get(`${server.url}/missing`).toPromise();
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBeInstanceOf(MaxRetriesExceededError);
      const underlying = (result.error as MaxRetriesExceededError).lastError;
      expect(underlying).toBeInstanceOf(NetworkError);
      expect((underlying as NetworkError).statusCode).toBe(404);
    }
  });

  it("cancel() aborts the ticket immediately", async () => {
    server.setHandler((_req, res) => {
      setTimeout(() => { try { res.writeHead(200); res.end("{}"); } catch {} }, 5000);
    });
    const ticket = client.get(`${server.url}/cancel-me`);
    setTimeout(() => ticket.cancel(), 20);
    const result = await ticket.toPromise();
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.constructor.name).toBe("CancelledError");
  }, 5_000);

  it("middleware pipeline modifies request headers", async () => {
    let receivedHeader = "";
    server.setHandler((req, res) => {
      receivedHeader = req.headers["x-custom"] as string;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{}");
    });
    const middlewareClient = HttpClient.create();
    middlewareClient.use(async (options, next) => {
      return next({ ...options, headers: { ...options.headers, "x-custom": "relay-test" } });
    });
    await middlewareClient.get(`${server.url}/headers`).toPromise();
    expect(receivedHeader).toBe("relay-test");
  });
});
