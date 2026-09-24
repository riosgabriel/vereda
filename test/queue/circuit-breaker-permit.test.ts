import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpClient } from "../../src/core/client.js";
import { HttpError, NetworkError } from "../../src/core/errors.js";
import { CircuitBreaker } from "../../src/queue/circuit-breaker.js";

const RESET_MS = 1_000;

/** A breaker already tripped open and moved to half-open. */
function halfOpenBreaker(halfOpenMaxAttempts = 1): CircuitBreaker {
	const cb = new CircuitBreaker("test", {
		enabled: true,
		failureThreshold: 1,
		resetTimeoutMs: RESET_MS,
		halfOpenMaxAttempts,
	});
	cb.tryAcquire()!.failure(new NetworkError("boom"));
	expect(cb.tryAcquire()).toBeNull();
	vi.advanceTimersByTime(RESET_MS);
	return cb;
}

function http404(): HttpError {
	return new HttpError("HTTP 404 Not Found", 404, new Response(null, { status: 404 }));
}

describe("CircuitPermit — half-open trial slots are never leaked (B1)", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("release() frees the trial slot for the next caller", () => {
		const cb = halfOpenBreaker();
		const trial = cb.tryAcquire()!;
		expect(cb.tryAcquire()).toBeNull();
		trial.release();
		expect(cb.tryAcquire()).not.toBeNull();
	});

	it("a neutral (non-failure) outcome does not wedge the breaker", () => {
		const cb = halfOpenBreaker();
		cb.tryAcquire()!.failure(http404());
		expect(cb.tryAcquire()).not.toBeNull();
	});

	it("a half-open trial answered with a neutral error closes the circuit", () => {
		const events: string[] = [];
		const cb = new CircuitBreaker(
			"test",
			{ enabled: true, failureThreshold: 1, resetTimeoutMs: RESET_MS },
			(_p, state) => events.push(state),
		);
		cb.tryAcquire()!.failure(new NetworkError("boom"));
		vi.advanceTimersByTime(RESET_MS);
		cb.tryAcquire()!.failure(http404());
		expect(events).toEqual(["open", "closed"]);
		// Closed: many concurrent admissions, not a single trial slot.
		expect(cb.tryAcquire()).not.toBeNull();
		expect(cb.tryAcquire()).not.toBeNull();
	});

	it("while closed, a neutral error breaks a consecutive-failure run", () => {
		const cb = new CircuitBreaker("test", { enabled: true, failureThreshold: 2 });
		cb.tryAcquire()!.failure(new NetworkError("boom"));
		cb.tryAcquire()!.failure(http404());
		cb.tryAcquire()!.failure(new NetworkError("boom"));
		expect(cb.tryAcquire()).not.toBeNull(); // 1 consecutive, not 2
	});

	it("while closed, a neutral error counts as a non-failure in the rolling window", () => {
		const cb = new CircuitBreaker("test", {
			enabled: true,
			window: { sizeMs: 10_000, failureRatePercent: 50, minimumRequests: 4 },
		});
		cb.tryAcquire()!.failure(new NetworkError("boom"));
		cb.tryAcquire()!.failure(http404());
		cb.tryAcquire()!.failure(http404());
		cb.tryAcquire()!.failure(new NetworkError("boom"));
		expect(cb.tryAcquire()).not.toBeNull(); // 50% is not > 50%
	});

	it("settles once: a second release() cannot free someone else's slot", () => {
		const cb = halfOpenBreaker(2);
		const a = cb.tryAcquire()!;
		cb.tryAcquire()!;
		a.release();
		a.release();
		expect(cb.tryAcquire()).not.toBeNull(); // the slot `a` held
		expect(cb.tryAcquire()).toBeNull(); // not a phantom second one
	});

	it("an outcome reported after release() is ignored", () => {
		const cb = halfOpenBreaker();
		const trial = cb.tryAcquire()!;
		trial.release();
		trial.failure(new NetworkError("late"));
		expect(cb.tryAcquire()).not.toBeNull(); // still half-open, not re-opened
	});

	it("a request admitted while closed cannot decide a later half-open episode", () => {
		const cb = new CircuitBreaker("test", { enabled: true, failureThreshold: 1, resetTimeoutMs: RESET_MS });
		const stale = cb.tryAcquire()!; // admitted while closed
		cb.tryAcquire()!.failure(new NetworkError("boom")); // trips open
		vi.advanceTimersByTime(RESET_MS);
		cb.tryAcquire()!; // the real half-open trial, still in flight
		stale.success();
		// Had the stale success closed the circuit, this would be admitted.
		expect(cb.tryAcquire()).toBeNull();
	});

	it("a permit from an earlier half-open episode cannot free a slot in the current one", () => {
		const cb = halfOpenBreaker(2);
		const a = cb.tryAcquire()!;
		const b = cb.tryAcquire()!; // same episode, still in flight
		a.failure(new NetworkError("boom")); // episode 1 ends -> open
		vi.advanceTimersByTime(RESET_MS);
		cb.tryAcquire()!; // episode 2 fills both trial slots
		cb.tryAcquire()!;
		b.release();
		expect(cb.tryAcquire()).toBeNull();
	});
});

describe("CircuitBreaker through HttpClient (B1)", () => {
	const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

	it("a half-open trial answered with a 404 does not reject every later request", async () => {
		let calls = 0;
		const fetch: typeof globalThis.fetch = async () => {
			calls++;
			if (calls === 1) throw new TypeError("connection refused");
			return new Response(null, { status: 404 });
		};
		const client = HttpClient.create({
			timeout: { attemptMs: 1_000 },
			retry: { maxRetries: 0 },
			fetch,
			circuitBreaker: { enabled: true, failureThreshold: 1, resetTimeoutMs: 20 },
		});

		await client.get("http://svc/").toPromise(); // trips open
		await sleep(30);
		const trial = await client.get("http://svc/").toPromise();
		expect(trial.success === false && trial.error.kind).toBe("http");

		for (let i = 0; i < 3; i++) {
			await sleep(30);
			const r = await client.get("http://svc/").toPromise();
			expect(r.success === false && r.error.kind).toBe("http");
		}
	});

	it("a cancelled half-open trial frees its slot", async () => {
		let calls = 0;
		const fetch: typeof globalThis.fetch = (_input, init) => {
			calls++;
			if (calls === 1) return Promise.reject(new TypeError("connection refused"));
			if (calls === 2) {
				return new Promise((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
				});
			}
			return Promise.resolve(new Response(null, { status: 200 }));
		};
		const client = HttpClient.create({
			timeout: { attemptMs: 1_000 },
			retry: { maxRetries: 0 },
			fetch,
			circuitBreaker: { enabled: true, failureThreshold: 1, resetTimeoutMs: 20 },
		});

		await client.get("http://svc/").toPromise(); // trips open
		await sleep(30);
		const trial = client.get("http://svc/");
		await sleep(5);
		trial.cancel();
		await sleep(5);

		const r = await client.get("http://svc/").toPromise();
		expect(r.success).toBe(true);
	});
});
