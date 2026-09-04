import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HttpClient } from "../../src/core/client.js";
import { ConfigurationError } from "../../src/core/errors.js";

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
        setHandler: (fn) => {
          handler = fn;
        },
      });
    });
  });
}

/** Collect the request body chunks into a single string. */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

function makeStream(payload: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(payload));
      controller.close();
    },
  });
}

const fastRetry = { backoff: { baseDelayMs: 10, jitter: false } };

describe("replayable bodies", () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await createTestServer();
  });

  afterAll(async () => {
    await server.close();
  });

  it("replays a factory ReadableStream body on retry (acceptance)", async () => {
    const payload = "x".repeat(1024);
    const captured: string[] = [];
    let hits = 0;
    server.setHandler(async (req, res) => {
      hits++;
      captured.push(await readBody(req));
      if (hits === 1) {
        res.writeHead(503);
        res.end("unavailable");
      } else {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      }
    });

    const client = HttpClient.create();
    const result = await client
      .post(`${server.url}/replay`, () => makeStream(payload), {
        retry: { ...fastRetry, idempotent: true },
      })
      .toPromise();

    expect(result.success).toBe(true);
    expect(hits).toBe(2);
    expect(captured).toHaveLength(2);
    expect(captured[0]).toBe(payload);
    expect(captured[1]).toBe(payload);
  }, 10_000);

  it("rejects a raw ReadableStream body with ConfigurationError (no throw)", async () => {
    let hits = 0;
    server.setHandler((_req, res) => {
      hits++;
      res.writeHead(200);
      res.end("{}");
    });

    const client = HttpClient.create();
    let ticket: ReturnType<HttpClient["post"]>;
    expect(() => {
      ticket = client.post(`${server.url}/raw`, makeStream("hello"));
    }).not.toThrow();

    const result = await ticket!.toPromise();
    expect(hits).toBe(0);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBeInstanceOf(ConfigurationError);
      expect(result.error.kind).toBe("configuration");
    }
  });

  it("surfaces a throwing body factory as ConfigurationError (no retry)", async () => {
    let hits = 0;
    server.setHandler(async (_req, res) => {
      hits++;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });

    const client = HttpClient.create();
    const result = await client
      .post(
        `${server.url}/throw`,
        () => {
          throw new Error("factory broken");
        },
        { retry: { ...fastRetry, idempotent: true } },
      )
      .toPromise();

    expect(hits).toBe(0); // request never reached the server
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBeInstanceOf(ConfigurationError);
      expect(result.error.kind).toBe("configuration");
      expect(result.error.message).toContain("factory broken");
    }
  });

  it("replays a factory string body on retry", async () => {
    const captured: string[] = [];
    let hits = 0;
    server.setHandler(async (req, res) => {
      hits++;
      captured.push(await readBody(req));
      if (hits === 1) {
        res.writeHead(503);
        res.end("unavailable");
      } else {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      }
    });

    const client = HttpClient.create();
    const result = await client
      .post(`${server.url}/string`, () => "hello", {
        retry: { ...fastRetry, idempotent: true },
      })
      .toPromise();

    expect(result.success).toBe(true);
    expect(hits).toBe(2);
    expect(captured).toEqual(["hello", "hello"]);
  }, 10_000);
});
