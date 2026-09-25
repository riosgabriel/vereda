import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpClient } from "../../src/core/client.ts";
import { parseRetryAfter } from "../../src/queue/executor.ts";

describe("parseRetryAfter", () => {
	it("parses integer seconds into ms", () => {
		expect(parseRetryAfter("2")).toBe(2000);
	});

	it("returns undefined for garbage", () => {
		expect(parseRetryAfter("soon")).toBeUndefined();
		expect(parseRetryAfter(null)).toBeUndefined();
	});

	it("clamps a past HTTP-date to 0", () => {
		const past = new Date(Date.now() - 60_000).toUTCString();
		expect(parseRetryAfter(past)).toBe(0);
	});
});

/**
 * These tests exercise the same "does Retry-After actually delay the retry"
 * behavior the old real-server tests did, but drive it with fake timers over
 * a mocked `fetch` instead of a real `node:http` server + real waits. That
 * turns four ~1s+ real-clock tests into sub-millisecond, deterministic ones:
 * the retry delay is advanced explicitly with `vi.advanceTimersByTimeAsync`
 * rather than actually elapsing, and we assert the retry hasn't fired yet at
 * `delay - epsilon` and has fired by `delay + epsilon`, which is what "delays
 * the retry by ~N ms" actually means.
 */
describe("Retry-After honors (fake timers)", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	function okResponse(): Response {
		return new Response(JSON.stringify({ ok: true }), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		});
	}

	it("429 Retry-After: 1 delays the retry by ~1s despite baseDelayMs 10", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(new Response("too many", { status: 429, headers: { "Retry-After": "1" } }))
			.mockResolvedValueOnce(okResponse());

		const client = HttpClient.create({
			timeout: { attemptMs: 5_000 },
			fetch: fetchMock as unknown as typeof globalThis.fetch,
			retry: { backoff: { baseDelayMs: 10, jitter: false } },
		});

		const resultPromise = client.get("http://example.test/seconds").toPromise();

		// First (real, but mocked-instant) attempt settles.
		await vi.advanceTimersByTimeAsync(0);
		expect(fetchMock).toHaveBeenCalledTimes(1);

		// Not yet at the 1000ms Retry-After delay: no retry fired.
		await vi.advanceTimersByTimeAsync(900);
		expect(fetchMock).toHaveBeenCalledTimes(1);

		// Past the delay: the retry fires.
		await vi.advanceTimersByTimeAsync(150);
		expect(fetchMock).toHaveBeenCalledTimes(2);

		const result = await resultPromise;
		expect(result.success).toBe(true);
	});

	it("caps a long Retry-After at maxDelayMs", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(new Response("too many", { status: 429, headers: { "Retry-After": "120" } }))
			.mockResolvedValueOnce(okResponse());

		const client = HttpClient.create({
			timeout: { attemptMs: 5_000 },
			fetch: fetchMock as unknown as typeof globalThis.fetch,
			retry: { backoff: { baseDelayMs: 10, maxDelayMs: 500, jitter: false } },
		});

		const resultPromise = client.get("http://example.test/capped").toPromise();
		await vi.advanceTimersByTimeAsync(0);
		expect(fetchMock).toHaveBeenCalledTimes(1);

		// A 120s Retry-After should be capped to maxDelayMs (500ms), not honored raw.
		await vi.advanceTimersByTimeAsync(499);
		expect(fetchMock).toHaveBeenCalledTimes(1);

		await vi.advanceTimersByTimeAsync(1);
		expect(fetchMock).toHaveBeenCalledTimes(2);

		const result = await resultPromise;
		expect(result.success).toBe(true);
	});

	it("honors an HTTP-date Retry-After", async () => {
		// ~2s ahead. HTTP-date has whole-second resolution, so the delay
		// `parseRetryAfter` actually computes from "now" can land anywhere in
		// (2000, 3000]ms depending on the sub-second remainder at the moment
		// the date string is built — compute it the same way the code under
		// test does, rather than assuming an exact value, so the window below
		// isn't flaky.
		const retryAt = new Date(Date.now() + 2000).toUTCString();
		const expectedDelayMs = parseRetryAfter(retryAt);
		expect(expectedDelayMs).toBeGreaterThan(0);

		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(new Response("too many", { status: 429, headers: { "Retry-After": retryAt } }))
			.mockResolvedValueOnce(okResponse());

		const client = HttpClient.create({
			timeout: { attemptMs: 5_000 },
			fetch: fetchMock as unknown as typeof globalThis.fetch,
			retry: { backoff: { baseDelayMs: 10, jitter: false } },
		});

		const resultPromise = client.get("http://example.test/http-date").toPromise();
		await vi.advanceTimersByTimeAsync(0);
		expect(fetchMock).toHaveBeenCalledTimes(1);

		await vi.advanceTimersByTimeAsync((expectedDelayMs as number) - 1);
		expect(fetchMock).toHaveBeenCalledTimes(1);

		await vi.advanceTimersByTimeAsync(1);
		expect(fetchMock).toHaveBeenCalledTimes(2);

		const result = await resultPromise;
		expect(result.success).toBe(true);
	});

	it("falls back to backoff for garbage Retry-After", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(new Response("too many", { status: 429, headers: { "Retry-After": "soon" } }))
			.mockResolvedValueOnce(okResponse());

		const client = HttpClient.create({
			timeout: { attemptMs: 5_000 },
			fetch: fetchMock as unknown as typeof globalThis.fetch,
			retry: { backoff: { baseDelayMs: 10, jitter: false } },
		});

		const resultPromise = client.get("http://example.test/garbage").toPromise();
		await vi.advanceTimersByTimeAsync(0);
		expect(fetchMock).toHaveBeenCalledTimes(1);

		// Garbage Retry-After falls back to the 10ms backoff, nowhere near 1s.
		await vi.advanceTimersByTimeAsync(10);
		expect(fetchMock).toHaveBeenCalledTimes(2);

		const result = await resultPromise;
		expect(result.success).toBe(true);
	});
});
