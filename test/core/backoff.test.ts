import { describe, it, expect } from "vitest";
import { buildBackoffFn } from "../../src/core/backoff.js";

describe("buildBackoffFn", () => {
  it("returns a custom function as-is", () => {
    const custom = (attempt: number) => attempt * 100;
    const fn = buildBackoffFn(custom);
    expect(fn(3)).toBe(300);
  });

  it("produces exponential growth without jitter", () => {
    const fn = buildBackoffFn({ baseDelayMs: 100, jitter: false, maxDelayMs: 10_000 });
    expect(fn(0)).toBe(100);
    expect(fn(1)).toBe(200);
    expect(fn(2)).toBe(400);
    expect(fn(3)).toBe(800);
  });

  it("caps at maxDelayMs", () => {
    const fn = buildBackoffFn({ baseDelayMs: 1000, jitter: false, maxDelayMs: 2000 });
    expect(fn(5)).toBe(2000);
  });

  it("returns value in [0, cap] with jitter", () => {
    const fn = buildBackoffFn({ baseDelayMs: 100, jitter: true, maxDelayMs: 10_000 });
    for (let i = 0; i < 50; i++) {
      const delay = fn(3);
      expect(delay).toBeGreaterThanOrEqual(0);
      expect(delay).toBeLessThanOrEqual(800);
    }
  });

  it("uses sensible defaults", () => {
    const fn = buildBackoffFn();
    const delay = fn(0);
    expect(delay).toBeGreaterThanOrEqual(0);
    expect(delay).toBeLessThanOrEqual(200);
  });
});
