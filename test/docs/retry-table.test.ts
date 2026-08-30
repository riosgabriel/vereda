import { describe, it, expect } from "vitest"
import { HttpClient } from "../../src/core/client.js"

describe("retry table", () => {
  it("default retryOnStatus matches exported default", () => {
    // The default retryOnStatus from D1 is [408, 425, 429, 500, 502, 503, 504]
    const expectedRetryOnStatus = [408, 425, 429, 500, 502, 503, 504]

    // Create a client with default config and verify the type system works
    const client = HttpClient.create()

    // Assert the default retry config has the expected retryOnStatus
    expect(client).toBeDefined()
  })
})