import { describe, expect, expectTypeOf, it } from "vitest";
import {
	type AppError,
	CancelledError,
	CircuitOpenError,
	ConfigurationError,
	DeadlineExceededError,
	HttpError,
	isAppError,
	MaxRetriesExceededError,
	NetworkError,
	QueueFullError,
	RequestError,
	RetryableStatusError,
	TimeoutError,
	ValidationError,
} from "../../src/core/errors.ts";

describe("Error classes", () => {
	it("NetworkError has kind 'network'", () => {
		const err = new NetworkError("fail");
		expect(err.kind).toBe("network");
		expect(err).toBeInstanceOf(RequestError);
	});

	it("HttpError has kind 'http'", () => {
		const err = new HttpError("not found", 404, new Response());
		expect(err.kind).toBe("http");
		expect(err).toBeInstanceOf(RequestError);
	});

	it("RetryableStatusError has kind 'retryable_status'", () => {
		const err = new RetryableStatusError("rate limited", 429, new Response());
		expect(err.kind).toBe("retryable_status");
		expect(err).toBeInstanceOf(RequestError);
	});

	it("TimeoutError has kind 'timeout'", () => {
		const err = new TimeoutError("http://x", 500);
		expect(err.kind).toBe("timeout");
		expect(err).toBeInstanceOf(RequestError);
	});

	it("ValidationError has kind 'validation'", () => {
		const err = new ValidationError("bad", [{ path: "x" }]);
		expect(err.kind).toBe("validation");
		expect(err).toBeInstanceOf(RequestError);
	});

	it("CancelledError has kind 'cancelled'", () => {
		const err = new CancelledError();
		expect(err.kind).toBe("cancelled");
		expect(err).toBeInstanceOf(RequestError);
	});

	it("QueueFullError has kind 'queue_full'", () => {
		const err = new QueueFullError("partition-a", 1, 1);
		expect(err.kind).toBe("queue_full");
		expect(err).toBeInstanceOf(RequestError);
	});

	it("ConfigurationError has kind 'configuration'", () => {
		const err = new ConfigurationError("concurrency");
		expect(err.kind).toBe("configuration");
		expect(err).toBeInstanceOf(RequestError);
	});

	it("MaxRetriesExceededError has kind 'max_retries'", () => {
		const inner = new NetworkError("fail");
		const err = new MaxRetriesExceededError(4, inner);
		expect(err.kind).toBe("max_retries");
		expect(err).toBeInstanceOf(RequestError);
	});

	it("AppError union covers all expected kinds", () => {
		const expectedKinds = [
			"network",
			"http",
			"retryable_status",
			"timeout",
			"validation",
			"cancelled",
			"queue_full",
			"configuration",
			"max_retries",
			"deadline",
		] as const;
		expect(expectedKinds).toHaveLength(10);
		// Every member of AppError["kind"] must be in expectedKinds
		const kind: AppError["kind"] = "network";
		expect(expectedKinds).toContain(kind);
	});

	it("NetworkError no longer has statusCode or response", () => {
		const err = new NetworkError("fail");
		expect(err).not.toHaveProperty("statusCode");
		expect(err).not.toHaveProperty("response");
	});

	it("HttpError preserves statusCode and response", () => {
		const res = new Response(null, { status: 404 });
		const err = new HttpError("not found", 404, res);
		expect(err.statusCode).toBe(404);
		expect(err.response).toBe(res);
	});

	it("QueueFullError has partition and queue info", () => {
		const err = new QueueFullError("api", 10, 5);
		expect(err.partition).toBe("api");
		expect(err.queueSize).toBe(10);
		expect(err.maxQueueSize).toBe(5);
	});

	it("DeadlineExceededError has kind 'deadline' with url and totalMs", () => {
		const err = new DeadlineExceededError("https://example.com", 5000);
		expect(err.kind).toBe("deadline");
		expect(err.url).toBe("https://example.com");
		expect(err.totalMs).toBe(5000);
		expect(err.message).toContain("exceeded total deadline of 5000ms");
	});

	it("narrows AppError to its class by switching on kind", () => {
		const describeError = (error: AppError): string => {
			switch (error.kind) {
				case "network":
				case "cancelled":
					return error.message;
				case "http":
				case "retryable_status":
					expectTypeOf(error).toEqualTypeOf<HttpError | RetryableStatusError>();
					return String(error.statusCode);
				case "timeout":
					return String(error.timeoutMs);
				case "deadline":
					return String(error.totalMs);
				case "validation":
					expectTypeOf(error).toEqualTypeOf<ValidationError>();
					return error.message;
				case "queue_full":
					return error.partition;
				case "circuit_open":
					expectTypeOf(error).toEqualTypeOf<CircuitOpenError>();
					return error.partition;
				case "configuration":
					return error.key;
				case "max_retries":
					return describeError(error.lastError);
				default: {
					const unreachable: never = error;
					return unreachable;
				}
			}
		};

		expect(describeError(new HttpError("not found", 404, new Response()))).toBe("404");
		expect(describeError(new CircuitOpenError("api"))).toBe("api");
		expect(describeError(new MaxRetriesExceededError(4, new TimeoutError("http://x", 500)))).toBe("500");
	});

	it("isAppError accepts the library's classes (and their subclasses) and nothing else", () => {
		class NotFoundError extends HttpError {}
		expect(isAppError(new HttpError("not found", 404, new Response()))).toBe(true);
		expect(isAppError(new NotFoundError("not found", 404, new Response()))).toBe(true);
		expect(isAppError(new CircuitOpenError("api"))).toBe(true);
		expect(isAppError(new RequestError("custom", "boom"))).toBe(false);
		expect(isAppError(new Error("boom"))).toBe(false);
		expect(isAppError({ kind: "http", message: "boom" })).toBe(false);
	});
});
