import { describe, expect, it, vi } from "vitest";
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
});
