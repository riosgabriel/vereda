import { describe, it, expect, vi } from "vitest";
import { defaultHeaders, requestLogger } from "../../src/middleware/index.js";
import type { NextFn } from "../../src/queue/executor.js";

describe("defaultHeaders", () => {
  it("merges base headers with request headers, request wins on conflict", async () => {
    const mw = defaultHeaders({ "X-Api-Key": "secret", "X-Shared": "base" });
    let passed: any;
    const next = vi.fn(async (opts: any) => {
      passed = opts;
      return new Response("ok", { status: 200 });
    });

    await mw(
      { headers: { "X-Shared": "req", "X-Other": "b" } } as any,
      next as unknown as NextFn
    );

    expect(next).toHaveBeenCalledOnce();
    expect(passed.headers).toEqual({
      "X-Api-Key": "secret",
      "X-Shared": "req",
      "X-Other": "b",
    });
  });

  it("uses base headers when the request has none", async () => {
    const mw = defaultHeaders({ "X-Api-Key": "secret" });
    let passed: any;
    const next = vi.fn(async (opts: any) => {
      passed = opts;
      return new Response("ok", { status: 200 });
    });

    await mw({} as any, next as unknown as NextFn);

    expect(passed.headers).toEqual({ "X-Api-Key": "secret" });
  });

  it("does not mutate the original options object", async () => {
    const mw = defaultHeaders({ "X-Api-Key": "secret" });
    const next = vi.fn(async () => new Response("ok"));
    const options = { headers: { "X-Req": "r" } } as any;

    await mw(options, next as unknown as NextFn);

    expect(options.headers).toEqual({ "X-Req": "r" });
  });
});

describe("requestLogger", () => {
  it("logs 'Request completed' with status and duration on success", async () => {
    const log = vi.fn();
    const mw = requestLogger({ log });
    const next = vi.fn(async () => new Response("ok", { status: 201 }));

    const res = await mw({} as any, next as unknown as NextFn);

    expect(res.status).toBe(201);
    expect(log).toHaveBeenCalledOnce();
    const [msg, meta] = log.mock.calls[0];
    expect(msg).toBe("Request completed");
    expect(meta.status).toBe(201);
    expect(typeof meta.durationMs).toBe("number");
  });

  it("logs 'Request failed' with error and duration on failure, and rethrows", async () => {
    const log = vi.fn();
    const mw = requestLogger({ log });
    const err = new Error("boom");
    const next = vi.fn(async () => {
      throw err;
    });

    await expect(mw({} as any, next as unknown as NextFn)).rejects.toBe(err);

    expect(log).toHaveBeenCalledOnce();
    const [msg, meta] = log.mock.calls[0];
    expect(msg).toBe("Request failed");
    expect(meta.error).toBe("boom");
    expect(typeof meta.durationMs).toBe("number");
  });

  it("falls back to console.log when no custom log is provided", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const mw = requestLogger();
    const next = vi.fn(async () => new Response("ok", { status: 200 }));

    await mw({} as any, next as unknown as NextFn);

    expect(spy).toHaveBeenCalledOnce();
    spy.mockRestore();
  });
});
