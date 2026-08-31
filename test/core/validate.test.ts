import { describe, it, expect } from "vitest"
import { validateConfig } from "../../src/core/validate.js"
import { ConfigurationError } from "../../src/core/errors.js"

describe("validateConfig", () => {
  it("accepts valid empty config", () => {
    expect(() => validateConfig({})).not.toThrow()
  })

  it("accepts valid full config", () => {
    expect(() =>
      validateConfig({
        concurrency: 10,
        timeout: { attemptMs: 1000 },
        retry: { maxRetries: 3, backoff: { baseDelayMs: 200, maxDelayMs: 30000 } },
        partitions: {
          api: { concurrency: 5, maxQueueSize: 50 },
        },
      }),
    ).not.toThrow()
  })

  it("rejects negative concurrency", () => {
    expect(() => validateConfig({ concurrency: -1 })).toThrow(ConfigurationError)
  })

  it("rejects zero concurrency", () => {
    expect(() => validateConfig({ concurrency: 0 })).toThrow(ConfigurationError)
  })

  it("rejects non-integer concurrency", () => {
    expect(() => validateConfig({ concurrency: 1.5 })).toThrow(ConfigurationError)
  })

  it("rejects maxQueueSize < 1", () => {
    expect(() => validateConfig({ partitions: { x: { maxQueueSize: 0 } } })).toThrow(
      ConfigurationError,
    )
  })

  it("rejects negative maxRetries", () => {
    expect(() => validateConfig({ retry: { maxRetries: -1 } })).toThrow(ConfigurationError)
  })

  it("rejects attemptMs <= 0", () => {
    expect(() => validateConfig({ timeout: { attemptMs: 0 } })).toThrow(ConfigurationError)
  })

  it("rejects negative attemptMs", () => {
    expect(() => validateConfig({ timeout: { attemptMs: -100 } })).toThrow(ConfigurationError)
  })

  it("rejects baseDelayMs > maxDelayMs", () => {
    expect(() =>
      validateConfig({ retry: { backoff: { baseDelayMs: 1000, maxDelayMs: 100 } } }),
    ).toThrow(ConfigurationError)
  })

  it("rejects negative baseDelayMs", () => {
    expect(() => validateConfig({ retry: { backoff: { baseDelayMs: -1 } } })).toThrow(
      ConfigurationError,
    )
  })

  it("rejects negative maxDelayMs", () => {
    expect(() => validateConfig({ retry: { backoff: { maxDelayMs: -1 } } })).toThrow(
      ConfigurationError,
    )
  })

  it("rejects partition concurrency < 1", () => {
    expect(() => validateConfig({ partitions: { api: { concurrency: 0 } } })).toThrow(
      ConfigurationError,
    )
  })

  it("rejects partition maxRetries < 0", () => {
    expect(() => validateConfig({ partitions: { api: { retry: { maxRetries: -1 } } } })).toThrow(
      ConfigurationError,
    )
  })
})
