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
	 *  exceed `maxWaitMs`. */
	reserve(now: number = Date.now()): number | null {
		this.refill(now);
		if (this.tokens >= 1) {
			this.tokens -= 1;
			return 0;
		}
		const waitMs = Math.ceil(((1 - this.tokens) / this.tokensPerSec) * 1000);
		if (this.maxWaitMs !== undefined && waitMs > this.maxWaitMs) return null;
		this.tokens -= 1;
		return waitMs;
	}

	/** Ms the next reservation would wait at `now`, without reserving. */
	nextWaitMs(now: number = Date.now()): number {
		this.refill(now);
		return this.tokens >= 1 ? 0 : Math.ceil(((1 - this.tokens) / this.tokensPerSec) * 1000);
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

	private refill(now: number): void {
		const elapsed = now - this.refilledAt;
		if (elapsed <= 0) return;
		this.tokens = Math.min(this.burst, this.tokens + (elapsed / 1000) * this.tokensPerSec);
		this.refilledAt = now;
	}
}
