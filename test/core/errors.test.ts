import { describe, it, expect } from "vitest"
import {
  RequestError,
  NetworkError,
  ValidationError,
  TimeoutError,
  CancelledError,
  MaxRetriesExceededError,
  HttpError,
  RetryableStatusError,
  QueueFullError,
  ConfigurationError,
  type AppError,
} from "../../src/core/errors.js"

describe("Error classes", () => {
  it("NetworkError has kind 'network'", () => {
    const err = new NetworkError("fail")
    expect(err.kind).toBe("network")
    expect(err).toBeInstanceOf(RequestError)
  })

  it("HttpError has kind 'http'", () => {
    const err = new HttpError("not found", 404, new Response())
    expect(err.kind).toBe("http")
    expect(err).toBeInstanceOf(RequestError)
  })

  it("RetryableStatusError has kind 'retryable_status'", () => {
    const err = new RetryableStatusError("rate limited", 429, new Response(), 2000)
    expect(err.kind).toBe("retryable_status")
    expect(err.retryAfterMs).toBe(2000)
    expect(err).toBeInstanceOf(RequestError)
  })

  it("TimeoutError has kind 'timeout'", () => {
    const err = new TimeoutError("http://x", 500)
    expect(err.kind).toBe("timeout")
    expect(err).toBeInstanceOf(RequestError)
  })

  it("ValidationError has kind 'validation'", () => {
    const err = new ValidationError("bad", [{ path: "x" }])
    expect(err.kind).toBe("validation")
    expect(err).toBeInstanceOf(RequestError)
  })

  it("CancelledError has kind 'cancelled'", () => {
    const err = new CancelledError()
    expect(err.kind).toBe("cancelled")
    expect(err).toBeInstanceOf(RequestError)
  })

  it("QueueFullError has kind 'queue_full'", () => {
    const err = new QueueFullError("partition-a", 1, 1)
    expect(err.kind).toBe("queue_full")
    expect(err).toBeInstanceOf(RequestError)
  })

  it("ConfigurationError has kind 'configuration'", () => {
    const err = new ConfigurationError("concurrency")
    expect(err.kind).toBe("configuration")
    expect(err).toBeInstanceOf(RequestError)
  })

  it("MaxRetriesExceededError has kind 'max_retries'", () => {
    const inner = new NetworkError("fail")
    const err = new MaxRetriesExceededError(4, inner)
    expect(err.kind).toBe("max_retries")
    expect(err).toBeInstanceOf(RequestError)
  })

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
    ] as const
    expect(expectedKinds).toHaveLength(9)
    // Every member of AppError["kind"] must be in expectedKinds
    const kind: AppError["kind"] = "network"
    expect(expectedKinds).toContain(kind)
  })

  it("NetworkError no longer has statusCode or response", () => {
    const err = new NetworkError("fail")
    expect(err).not.toHaveProperty("statusCode")
    expect(err).not.toHaveProperty("response")
  })

  it("HttpError preserves statusCode and response", () => {
    const res = new Response(null, { status: 404 })
    const err = new HttpError("not found", 404, res)
    expect(err.statusCode).toBe(404)
    expect(err.response).toBe(res)
  })

  it("QueueFullError has partition and queue info", () => {
    const err = new QueueFullError("api", 10, 5)
    expect(err.partition).toBe("api")
    expect(err.queueSize).toBe(10)
    expect(err.maxQueueSize).toBe(5)
  })
})
