import { describe, expect, it, vi } from "vitest";
import { defaultHeaders, requestLogger } from "../../src/middleware/index.ts";
import type { NextFn, RequestContext } from "../../src/queue/executor.ts";

function ctx(overrides: Partial<RequestContext> = {}): RequestContext {
	return {
		url: "https://example.com/",
		method: "GET",
		headers: new Headers(),
		signal: new AbortController().signal,
		attempt: 0,
		ticketId: "t1",
		partition: "example.com",
		...overrides,
	};
}

describe("defaultHeaders", () => {
	it("sets configured headers on the request", async () => {
		const middleware = defaultHeaders({ "X-Api-Key": "secret" });
		const next: NextFn = vi.fn(async () => new Response(null, { status: 200 }));
		const requestCtx = ctx();

		await middleware(requestCtx, next);

		expect(next).toHaveBeenCalledWith(requestCtx);
		expect(requestCtx.headers.get("X-Api-Key")).toBe("secret");
	});

	it("lets a same-case per-request header override the default", async () => {
		const middleware = defaultHeaders({ "X-Api-Key": "secret", Accept: "application/json" });
		const next: NextFn = vi.fn(async () => new Response(null, { status: 200 }));
		const requestCtx = ctx({ headers: new Headers({ "X-Api-Key": "override" }) });

		await middleware(requestCtx, next);

		expect(requestCtx.headers.get("X-Api-Key")).toBe("override");
		expect(requestCtx.headers.get("Accept")).toBe("application/json");
	});

	it("treats headers case-insensitively — request wins, no duplicate", async () => {
		const middleware = defaultHeaders({ Authorization: "Bearer default" });
		const next: NextFn = vi.fn(async () => new Response(null, { status: 200 }));
		const requestCtx = ctx({ headers: new Headers({ authorization: "Bearer request" }) });

		await middleware(requestCtx, next);

		expect(requestCtx.headers.get("authorization")).toBe("Bearer request");
		expect([...requestCtx.headers.keys()].filter((k) => k.toLowerCase() === "authorization")).toHaveLength(1);
	});

	it("leaves url and method untouched", async () => {
		const middleware = defaultHeaders({ "X-Api-Key": "secret" });
		const next: NextFn = vi.fn(async () => new Response(null, { status: 200 }));
		const requestCtx = ctx({ method: "POST", url: "https://example.com/x" });

		await middleware(requestCtx, next);

		expect(requestCtx.method).toBe("POST");
		expect(requestCtx.url).toBe("https://example.com/x");
	});
});

describe("requestLogger", () => {
	it("logs completion with status and duration on success", async () => {
		const log = vi.fn();
		const middleware = requestLogger({ log });
		const next: NextFn = vi.fn(async () => new Response(null, { status: 204 }));

		const response = await middleware(ctx(), next);

		expect(response.status).toBe(204);
		expect(log).toHaveBeenCalledTimes(1);
		expect(log).toHaveBeenCalledWith(
			"Request completed",
			expect.objectContaining({ status: 204, durationMs: expect.any(Number) }),
		);
	});

	it("logs failure with the error message and rethrows", async () => {
		const log = vi.fn();
		const middleware = requestLogger({ log });
		const next: NextFn = vi.fn(async () => {
			throw new Error("boom");
		});

		await expect(middleware(ctx(), next)).rejects.toThrow("boom");
		expect(log).toHaveBeenCalledWith(
			"Request failed",
			expect.objectContaining({ error: "boom", durationMs: expect.any(Number) }),
		);
	});

	it("stringifies non-Error throws", async () => {
		const log = vi.fn();
		const middleware = requestLogger({ log });
		const next: NextFn = vi.fn(async () => {
			throw "raw string failure";
		});

		await expect(middleware(ctx(), next)).rejects.toBe("raw string failure");
		expect(log).toHaveBeenCalledWith("Request failed", expect.objectContaining({ error: "raw string failure" }));
	});

	it("defaults to console.log when no logger is provided", async () => {
		const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const middleware = requestLogger();
		const next: NextFn = vi.fn(async () => new Response(null, { status: 200 }));

		await middleware(ctx(), next);

		expect(consoleSpy).toHaveBeenCalledWith("Request completed", expect.objectContaining({ status: 200 }));
		consoleSpy.mockRestore();
	});
});
