import type { RateLimitConfig } from "../core/types.ts";

/** Token bucket for one partition. Callers reserve tokens up front, as in
 *  Go's `x/time/rate`: the balance may go negative, and each caller is told
 *  exactly how long until its own token exists. Reservations are therefore
 *  served in arrival order without a waiter queue, and the long-run rate
 *  never exceeds `tokensPerSec`. */
export class TokenBucket {
	readonly tokensPerSec: number;
	readonly burst: number;
	readonly maxWaitMs: number | undefined;
	private tokens: number;
	private refilledAt: number;

	constructor(config: RateLimitConfig, now: number = Date.now()) {
		this.tokensPerSec = config.tokensPerSec;
		// One second's worth by default, and never below a single token, or a
		// rate under 1/s could never grant one.
		this.burst = config.burst ?? Math.max(1, config.tokensPerSec);
		this.maxWaitMs = config.maxWaitMs;
		this.tokens = this.burst;
		this.refilledAt = now;
	}

	/** Reserve one token. Returns the ms to wait before it may be used (0 when
	 *  one is free now), or `null`, reserving nothing, when that wait would
	 *  exceed `maxWaitMs`. With `at`, the token is reserved as of that time
	 *  rather than now (`at` in the past means now), so the wait runs from
	 *  `at`, as when a partition is paused until then. */
	reserve(now: number = Date.now(), at: number = now): number | null {
		const waitMs = this.waitFrom(now, at);
		if (this.maxWaitMs !== undefined && waitMs > this.maxWaitMs) return null;
		this.tokens -= 1;
		return waitMs;
	}

	/** Ms the next reservation would wait at `now`, without reserving. */
	nextWaitMs(now: number = Date.now()): number {
		return this.waitFrom(now, now);
	}

	/** Drain the bucket until `until`: it holds no more than 0 tokens by then,
	 *  so traffic resumes at `tokensPerSec` instead of in a burst. Reservations
	 *  already made stay owed. Never moves the refill point back. */
	freezeUntil(until: number, now: number = Date.now()): void {
		this.refill(now);
		this.tokens = Math.min(this.tokens, 0);
		this.refilledAt = Math.max(this.refilledAt, until);
	}

	/** Hand back a reserved token that was never used (its caller aborted). */
	refund(now: number = Date.now()): void {
		this.refill(now);
		this.tokens = Math.min(this.burst, this.tokens + 1);
	}

	/** Tokens free right now; 0 while reservations are outstanding. */
	available(now: number = Date.now()): number {
		this.refill(now);
		return Math.max(0, this.tokens);
	}

	/** True once the bucket has refilled to `burst`: discarding it then can't
	 *  hand out a burst the real one wouldn't have. */
	isFull(now: number = Date.now()): boolean {
		this.refill(now);
		return this.tokens >= this.burst;
	}

	/** Ms from `now` until a token reserved as of `at` may be used. `refilledAt`
	 *  can lie in the future (after `freezeUntil`): nothing refills before it. */
	private waitFrom(now: number, at: number): number {
		const base = Math.max(now, at);
		this.refill(base);
		const readyAt = Math.max(base, this.refilledAt);
		const deficitMs = this.tokens >= 1 ? 0 : Math.ceil(((1 - this.tokens) / this.tokensPerSec) * 1000);
		return readyAt - now + deficitMs;
	}

	private refill(now: number): void {
		const elapsed = now - this.refilledAt;
		if (elapsed <= 0) return;
		this.tokens = Math.min(this.burst, this.tokens + (elapsed / 1000) * this.tokensPerSec);
		this.refilledAt = now;
	}
}
