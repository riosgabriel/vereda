import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpClient } from "../../src/core/client.ts";
import { DeadlineExceededError, RetryableStatusError } from "../../src/core/errors.ts";
import type { LifecycleEventMap } from "../../src/core/types.ts";

const busy = (retryAfter?: string) =>
	new Response("busy", { status: 503, headers: retryAfter ? { "Retry-After": retryAfter } : {} });

describe("deadline-aware retries (#143)", () => {
	it("fails right away when Retry-After outlasts the remaining totalMs", async () => {
		const fetchMock = vi.fn(async () => busy("2"));
		const client = HttpClient.create({
			timeout: { attemptMs: 5_000, totalMs: 500 },
			fetch: fetchMock as unknown as typeof globalThis.fetch,
		});
		const failures: LifecycleEventMap["failure"][] = [];
		const retries: LifecycleEventMap["retry"][] = [];
		client.on("failure", (e) => failures.push(e));
		client.on("retry", (e) => retries.push(e));

		const start = Date.now();
		const result = await client.get("http://example.test/busy").toPromise();
		const elapsed = Date.now() - start;

		expect(elapsed).toBeLessThan(250);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.error).toBeInstanceOf(DeadlineExceededError);
			expect(result.error.cause).toBeInstanceOf(RetryableStatusError);
		}
		expect(retries).toEqual([]);
		expect(failures).toHaveLength(1);
		expect(failures[0]?.error.kind).toBe("deadline");
		expect(failures[0]?.attempts).toBe(1);
	});

	it("still retries when the delay fits before the deadline", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(busy())
			.mockResolvedValueOnce(new Response("ok", { status: 200 }));
		const client = HttpClient.create({
			timeout: { attemptMs: 5_000, totalMs: 1_000 },
			retry: { backoff: { baseDelayMs: 20, jitter: false } },
			fetch: fetchMock as unknown as typeof globalThis.fetch,
		});

		const result = await client.get("http://example.test/flaky").toPromise();

		expect(result.success).toBe(true);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("leaves retries alone when totalMs is unset", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(busy("0"))
			.mockResolvedValueOnce(new Response("ok", { status: 200 }));
		const client = HttpClient.create({
			timeout: { attemptMs: 5_000 },
			fetch: fetchMock as unknown as typeof globalThis.fetch,
		});

		const result = await client.get("http://example.test/flaky").toPromise();

		expect(result.success).toBe(true);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	describe("when the deadline fires mid-retry", () => {
		afterEach(() => {
			vi.useRealTimers();
		});

		it("during a retry attempt, resolves DeadlineExceededError", async () => {
			let calls = 0;
			const fetchMock = vi.fn((_url: string, init: RequestInit) => {
				calls++;
				if (calls === 1) return Promise.resolve(busy());
				return new Promise<Response>((_, reject) =>
					init.signal?.addEventListener("abort", () => reject(init.signal?.reason)),
				);
			});
			const client = HttpClient.create({
				timeout: { attemptMs: 5_000, totalMs: 100 },
				retry: { backoff: { baseDelayMs: 1, jitter: false } },
				fetch: fetchMock as unknown as typeof globalThis.fetch,
			});
			const failures: LifecycleEventMap["failure"][] = [];
			client.on("failure", (e) => failures.push(e));

			const result = await client.get("http://example.test/hang").toPromise();

			expect(fetchMock).toHaveBeenCalledTimes(2);
			expect(!result.success && result.error).toBeInstanceOf(DeadlineExceededError);
			expect(failures.map((e) => [e.error.kind, e.attempts])).toEqual([["deadline", 2]]);
		});

		it("during the backoff sleep, resolves DeadlineExceededError", async () => {
			// The pre-sleep check compares against Date.now(), but the deadline is
			// a timer. Timers can run late or tie, so the deadline timer can still
			// win against a sleep the check let through. Faking only the timers
			// reproduces that: the first attempt takes 900ms of timer time and no
			// clock time, so the check sees 500ms of backoff fitting in 1s, while
			// the sleep ends at 1400ms, after the deadline timer at 1000ms.
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
			const fetchMock = vi.fn(() => new Promise<Response>((resolve) => setTimeout(() => resolve(busy()), 900)));
			const client = HttpClient.create({
				timeout: { attemptMs: 5_000, totalMs: 1_000 },
				retry: { backoff: { baseDelayMs: 500, jitter: false } },
				fetch: fetchMock as unknown as typeof globalThis.fetch,
			});
			const retries: LifecycleEventMap["retry"][] = [];
			client.on("retry", (e) => retries.push(e));

			const pending = client.get("http://example.test/slow").toPromise();
			await vi.advanceTimersByTimeAsync(1_000);
			const result = await pending;

			expect(retries).toHaveLength(1);
			expect(fetchMock).toHaveBeenCalledTimes(1);
			expect(!result.success && result.error).toBeInstanceOf(DeadlineExceededError);
		});
	});
});
