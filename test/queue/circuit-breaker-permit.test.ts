import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpClient } from "../../src/core/client.js";
import { CircuitOpenError, ConfigurationError, HttpError, NetworkError } from "../../src/core/errors.js";
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

/** A never-sent outcome: the body factory threw before any request left the
 *  process (executor.ts). The breaker must ignore it entirely. */
function neverSent(): ConfigurationError {
	return new ConfigurationError("body factory threw: boom");
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

describe("CircuitPermit — never-sent outcomes are ignored (body factory throw)", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("closed: a never-sent error between two real failures does not break the consecutive-failure run", () => {
		const cb = new CircuitBreaker("test", { enabled: true, failureThreshold: 3 });
		cb.tryAcquire()!.failure(new NetworkError("boom")); // 1
		cb.tryAcquire()!.failure(neverSent()); // ignored — still 1
		expect(cb.tryAcquire()).not.toBeNull();
		cb.tryAcquire()!.failure(new NetworkError("boom")); // 2
		expect(cb.tryAcquire()).not.toBeNull();
		cb.tryAcquire()!.failure(new NetworkError("boom")); // 3 -> opens
		expect(cb.tryAcquire()).toBeNull();
	});

	it("a never-sent error is not passed to a user-supplied isFailure", () => {
		const isFailure = vi.fn(() => true);
		const cb = new CircuitBreaker("test", { enabled: true, failureThreshold: 1, isFailure });
		cb.tryAcquire()!.failure(neverSent());
		expect(isFailure).not.toHaveBeenCalled();
		// With failureThreshold: 1, a recorded failure would have opened it.
		const next = cb.tryAcquire();
		expect(next).not.toBeNull();
		// The spy is wired up: a real error does reach it (and trips the circuit).
		const real = new NetworkError("boom");
		next!.failure(real);
		expect(isFailure).toHaveBeenCalledTimes(1);
		expect(isFailure).toHaveBeenCalledWith(real);
		expect(cb.tryAcquire()).toBeNull();
	});

	it("isFailure runs exactly once per reported outcome — closed, half-open, and not-a-failure", () => {
		let verdict = true;
		const isFailure = vi.fn(() => verdict);
		const cb = new CircuitBreaker("test", { enabled: true, failureThreshold: 2, resetTimeoutMs: RESET_MS, isFailure });

		cb.tryAcquire()!.failure(new NetworkError("boom")); // closed, counted
		expect(isFailure).toHaveBeenCalledTimes(1);

		verdict = false;
		cb.tryAcquire()!.failure(http404()); // not a failure
		expect(isFailure).toHaveBeenCalledTimes(2);

		verdict = true;
		cb.tryAcquire()!.failure(new NetworkError("boom")); // 1 (404 reset the run)
		cb.tryAcquire()!.failure(new NetworkError("boom")); // 2 -> opens
		expect(isFailure).toHaveBeenCalledTimes(4);
		expect(cb.tryAcquire()).toBeNull();

		vi.advanceTimersByTime(RESET_MS);
		cb.tryAcquire()!.failure(new NetworkError("boom")); // half-open trial -> reopens
		expect(isFailure).toHaveBeenCalledTimes(5);
		expect(cb.tryAcquire()).toBeNull();
	});

	it("half-open: a never-sent outcome frees the trial slot without closing or reopening", () => {
		const cb = halfOpenBreaker();
		const trial = cb.tryAcquire()!;
		expect(cb.tryAcquire()).toBeNull(); // trial slot taken
		trial.failure(neverSent());
		// A fresh trial slot is available again — still half-open, not closed
		// (closing would admit unlimited concurrent callers) and not reopened
		// (canRequest() would return false while open).
		const retrial = cb.tryAcquire();
		expect(retrial).not.toBeNull();
		expect(cb.tryAcquire()).toBeNull(); // only one trial slot at a time
	});

	it("half-open: after a never-sent outcome, a real failure still reopens the circuit", () => {
		const events: string[] = [];
		const cb = new CircuitBreaker(
			"test",
			{ enabled: true, failureThreshold: 1, resetTimeoutMs: RESET_MS },
			(_p, state) => events.push(state),
		);
		cb.tryAcquire()!.failure(new NetworkError("boom")); // opens
		vi.advanceTimersByTime(RESET_MS);
		cb.tryAcquire()!.failure(neverSent()); // ignored, trial slot freed
		cb.tryAcquire()!.failure(new NetworkError("boom")); // the real trial
		expect(events).toEqual(["open", "open"]);
		expect(cb.canRequest()).toBe(false);
	});

	it("half-open: after a never-sent outcome, a real success still closes the circuit", () => {
		const events: string[] = [];
		const cb = new CircuitBreaker(
			"test",
			{ enabled: true, failureThreshold: 1, resetTimeoutMs: RESET_MS },
			(_p, state) => events.push(state),
		);
		cb.tryAcquire()!.failure(new NetworkError("boom")); // opens
		vi.advanceTimersByTime(RESET_MS);
		const a = cb.tryAcquire()!; // first trial
		expect(cb.tryAcquire()).toBeNull(); // trial slot taken
		a.failure(neverSent()); // ignored, trial slot freed
		// Still half-open (a single trial slot), not closed (unlimited admits).
		expect(events).toEqual(["open"]);
		const b = cb.tryAcquire()!; // a fresh trial, reusing the freed slot
		b.success(); // the real trial
		expect(events).toEqual(["open", "closed"]);
		expect(cb.tryAcquire()).not.toBeNull();
		expect(cb.tryAcquire()).not.toBeNull(); // closed: no single trial slot
	});

	it("rolling window: a never-sent error does not count toward minimumRequests or the success count", () => {
		const cb = new CircuitBreaker("test", {
			enabled: true,
			window: { sizeMs: 10_000, failureRatePercent: 50, minimumRequests: 3 },
		});
		cb.tryAcquire()!.failure(new NetworkError("boom")); // total=1, failures=1
		cb.tryAcquire()!.failure(neverSent()); // ignored — must not raise total to 2
		cb.tryAcquire()!.failure(new NetworkError("boom")); // total=2, failures=2 (not 3)
		// Only 2 real requests recorded — below minimumRequests (3) — must stay
		// closed even though both real requests failed.
		expect(cb.tryAcquire()).not.toBeNull();
	});

	it("a 404 still counts as a success (regression guard)", () => {
		const cb = new CircuitBreaker("test", { enabled: true, failureThreshold: 2 });
		cb.tryAcquire()!.failure(new NetworkError("boom")); // 1
		cb.tryAcquire()!.failure(http404()); // resets the run
		cb.tryAcquire()!.failure(new NetworkError("boom")); // 1, not 3
		expect(cb.tryAcquire()).not.toBeNull();
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

	it("a throwing body factory between two real failures does not delay tripping the circuit", async () => {
		let fetchCalls = 0;
		const fetch: typeof globalThis.fetch = async () => {
			fetchCalls++;
			return new Response(null, { status: 503 });
		};
		const client = HttpClient.create({
			timeout: { attemptMs: 1_000 },
			retry: { maxRetries: 0 },
			fetch,
			circuitBreaker: { enabled: true, failureThreshold: 3, resetTimeoutMs: 1_000 },
		});
		const throwingBody = () => {
			throw new Error("factory broken");
		};

		const r1 = await client.post("http://svc/", "a").toPromise(); // real failure 1
		expect(r1.success === false && r1.error.kind).toBe("retryable_status");
		const r2 = await client.post("http://svc/", "b").toPromise(); // real failure 2
		expect(r2.success === false && r2.error.kind).toBe("retryable_status");
		const r3 = await client.post("http://svc/", throwingBody).toPromise(); // never sent
		expect(r3.success === false && r3.error.kind).toBe("configuration");
		expect(fetchCalls).toBe(2); // the throwing factory never reached fetch

		// On main, the never-sent outcome above resets the consecutive-failure
		// run, so this 3rd real failure would only bring the count to 1 and the
		// circuit would stay closed.
		const r4 = await client.post("http://svc/", "c").toPromise(); // real failure 3 -> opens
		expect(r4.success === false && r4.error.kind).toBe("retryable_status");
		expect(fetchCalls).toBe(3);

		const r5 = await client.post("http://svc/", "d").toPromise();
		expect(r5.success === false && r5.error).toBeInstanceOf(CircuitOpenError);
		expect(fetchCalls).toBe(3); // rejected before reaching fetch
	});
});
