import { CancelledError, QueueFullError, RateLimitedError, RetryableStatusError } from "../core/errors.ts";
import { setLongTimeout } from "../core/timer.ts";
import {
	DEFAULT_CONCURRENCY,
	DEFAULT_MAX_QUEUE_SIZE,
	type PartitionConfig,
	type PartitionLookup,
	partitionLookup,
} from "../core/types.ts";
import { PartitionRegistry } from "./partition-registry.ts";
import { PartitionPause } from "./pause.ts";
import { TokenBucket } from "./rate-limiter.ts";
import type { Semaphore } from "./semaphore.ts";

/** Default TTL (ms) before an idle partition registry entry (bulkhead,
 *  circuit breaker or retry budget) is swept from its registry. Shared by all
 *  three registries so the eviction policy stays in one place. */
export const DEFAULT_PARTITION_TTL_MS = 60_000;

/** What a guarded attempt resolves with when it reached the front of a queue
 *  during a pause: nothing was sent, and the caller admits it again. Never
 *  leaves the code that dispatches attempts. */
export const PAUSED: unique symbol = Symbol("paused");

export class Bulkhead {
	public readonly name: string;
	private readonly concurrency: number;
	private readonly maxQueueSize: number;
	private readonly _limitFirstAttempts: boolean;
	private running = 0;
	private activeTickets = 0;
	private readonly _waitQueue: Array<() => void> = [];
	private readonly bucket?: TokenBucket;
	private readonly pause?: PartitionPause;

	constructor(name: string, config: PartitionConfig = {}) {
		this.name = name;
		this.concurrency = config.concurrency ?? DEFAULT_CONCURRENCY;
		this.maxQueueSize = config.maxQueueSize ?? DEFAULT_MAX_QUEUE_SIZE;
		this._limitFirstAttempts = config.limitFirstAttempts ?? false;
		if (config.rateLimit) this.bucket = new TokenBucket(config.rateLimit);
		if (config.pauseOnRetryAfter) this.pause = new PartitionPause(config.pauseOnRetryAfter);
	}

	get queueSize(): number {
		return this._waitQueue.length;
	}

	get runningCount(): number {
		return this.running;
	}

	get concurrencyLimit(): number {
		return this.concurrency;
	}

	get maxQueueSizeLimit(): number {
		return this.maxQueueSize;
	}

	get limitFirstAttempts(): boolean {
		return this._limitFirstAttempts;
	}

	/** True when nothing is running or queued and no live ticket holds a
	 *  reference, so the bulkhead can be discarded without changing the
	 *  effective concurrency cap. */
	isEvictable(_now: number): boolean {
		return (
			this.activeTickets === 0 &&
			this.running === 0 &&
			this._waitQueue.length === 0 &&
			// A drained bucket must outlive its tickets: a fresh one starts full
			// and would let a burst through that the rate limit forbids.
			(this.bucket === undefined || this.bucket.isFull()) &&
			// A pause must outlive its tickets too: a fresh bulkhead would send
			// straight into the host that just said to wait.
			this.pauseRemainingMs === 0
		);
	}

	/** Ms until the partition may send again; 0 when it isn't paused. */
	get pauseRemainingMs(): number {
		return this.pause?.remaining() ?? 0;
	}

	/** Epoch ms the active pause ends at, or undefined when not paused. */
	get pausedUntil(): number | undefined {
		return this.pauseRemainingMs > 0 ? this.pause!.until : undefined;
	}

	/** Note a failed attempt's error. A `RetryableStatusError` whose status is
	 *  listed and which carries a positive `Retry-After` pauses the partition
	 *  (up to `maxPauseMs`) and drains its bucket until then; anything else is
	 *  ignored. A later pushback can extend a pause, never shorten it. */
	notePushback(error: unknown): void {
		const pause = this.pause;
		if (!pause || !(error instanceof RetryableStatusError)) return;
		const ms = error.retryAfterMs;
		if (ms === undefined || !(ms > 0) || !pause.statuses.includes(error.statusCode)) return;
		const until = pause.extend(ms);
		this.bucket?.freezeUntil(until);
	}

	/** Wrap an attempt's task so it respects the pause at the moment it really
	 *  starts, with its slot and permit already held, and records a pushback
	 *  the moment it settles. Start during a pause: nothing is sent and the
	 *  task resolves `PAUSED`, so the usual release paths free the permit and
	 *  the slot (D4). Settle with an `error` outcome: the pushback is noted
	 *  here, before the slot is released and the next queued attempt starts,
	 *  and before any callback of the caller's can throw. */
	guard<R extends { kind: string }>(task: () => Promise<R>): () => Promise<R | typeof PAUSED> {
		return () => {
			if (this.pauseRemainingMs > 0) return Promise.resolve(PAUSED);
			return task().then((result) => {
				if (result.kind === "error") this.notePushback((result as { error?: unknown }).error);
				return result;
			});
		};
	}

	/** The refusal a retry would meet if it waited `afterMs` first, or undefined
	 *  when it would be admitted, or when that can't be told without trying.
	 *  Only a pause that is still running by then can make it certain, and the
	 *  bucket stays frozen until the pause's end, so its wait is known then too.
	 *  Reserves nothing. */
	refusalAfter(afterMs: number): RateLimitedError | undefined {
		const maxWaitMs = this.bucket?.maxWaitMs;
		const remaining = this.pauseRemainingMs - afterMs;
		if (!this.bucket || maxWaitMs === undefined || remaining <= 0) return undefined;
		const now = Date.now();
		const waitMs = remaining + this.bucket.nextWaitMs(now + this.pauseRemainingMs);
		if (waitMs <= maxWaitMs) return undefined;
		return new RateLimitedError(this.name, waitMs, maxWaitMs, this.pause!.until);
	}

	/** Tokens free right now, or undefined when the partition has no rate limit. */
	get tokensAvailable(): number | undefined {
		return this.bucket?.available();
	}

	/** Admit one attempt: wait out a `Retry-After` pause and take a rate-limit
	 *  token. Returns undefined when the attempt may go now (no pause, and a
	 *  token was free or there is no rate limit); otherwise a promise that
	 *  resolves with the ms waited once the attempt is due. If `signal` aborts
	 *  first, the token is handed back and the promise rejects with
	 *  `CancelledError` (B9). Throws `RateLimitedError`, reserving nothing,
	 *  when the wait, pause included, would exceed `maxWaitMs`. A pause that is
	 *  extended while an attempt waits makes it wait again, keeping its token.
	 *  Without a rate limit, only `signal` ends a pause wait early. */
	takeToken(signal?: AbortSignal): Promise<number> | undefined {
		const bucket = this.bucket;
		const pauseMs = this.pauseRemainingMs;
		if (!bucket && pauseMs === 0) return undefined;
		let waitMs = pauseMs;
		if (bucket) {
			// A paused bucket reserves as of the pause's end, so the wait below
			// already covers it and maxWaitMs bounds the whole of it.
			const now = Date.now();
			const reserved = bucket.reserve(now, pauseMs > 0 ? this.pause!.until : now);
			if (reserved === null) {
				throw new RateLimitedError(
					this.name,
					pauseMs + bucket.nextWaitMs(now + pauseMs),
					bucket.maxWaitMs ?? Number.POSITIVE_INFINITY,
					pauseMs > 0 ? this.pause!.until : undefined,
				);
			}
			waitMs = reserved;
		}
		if (waitMs === 0) return undefined;
		// When this attempt is due, and how far the bucket's freezes had moved
		// its turn by then. A pause extended later moves it by the difference,
		// so waiters keep their order and their spacing behind the new end.
		const startedAt = Date.now();
		const dueAt = startedAt + waitMs;
		const shift0 = bucket?.shiftMs ?? 0;
		return new Promise<number>((resolve, reject) => {
			if (signal?.aborted) {
				bucket?.refund();
				reject(new CancelledError());
				return;
			}
			let cancelTimer = () => {};
			const onAbort = () => {
				cancelTimer();
				bucket?.refund();
				reject(new CancelledError());
			};
			const sleepFor = (ms: number) => {
				cancelTimer = setLongTimeout(() => {
					// The pause may have been extended while this attempt slept.
					const now = Date.now();
					const due = Math.max(dueAt + ((bucket?.shiftMs ?? 0) - shift0), this.pause?.until ?? 0);
					if (due > now) {
						sleepFor(due - now);
						return;
					}
					signal?.removeEventListener("abort", onAbort);
					resolve(now - startedAt);
				}, ms);
			};
			signal?.addEventListener("abort", onAbort, { once: true });
			sleepFor(waitMs);
		});
	}

	/** Mark a ticket as holding this bulkhead until the returned function is
	 *  called. A ticket keeps its reference across retry backoff, when nothing
	 *  is running or queued, so the registry must not evict it meanwhile.
	 *  The returned release is idempotent. */
	retain(): () => void {
		this.activeTickets++;
		let released = false;
		return () => {
			if (released) return;
			released = true;
			this.activeTickets--;
		};
	}

	/** Acquire a concurrency slot, execute `task`, release the slot.
	 *  Rejects with `QueueFullError` when the queue is at capacity.
	 *  `this.running` is decremented *before* the returned Promise resolves,
	 *  giving consumers an accurate count immediately after `await`.
	 *  When a global `semaphore` is provided, a permit is acquired after the
	 *  partition slot and released before it (D4).
	 *  `onDequeue`, if given, fires once — right before `task()` starts —
	 *  with the ms elapsed since `run()` was called, covering both the
	 *  partition wait and the semaphore wait.
	 *  If `signal` aborts while the caller is still waiting (for a partition
	 *  slot or a global permit), it leaves the queue and the promise rejects
	 *  with `CancelledError` without running `task` (B9). Once `task` has
	 *  started, cancelling it is the task's own job. */
	run<T>(
		task: () => Promise<T>,
		semaphore?: Semaphore,
		onDequeue?: (queuedMs: number) => void,
		signal?: AbortSignal,
	): Promise<T> {
		const enqueuedAt = Date.now();
		return new Promise<T>((resolve, reject) => {
			if (signal?.aborted) {
				reject(new CancelledError());
				return;
			}

			const onAbort = () => {
				const idx = this._waitQueue.indexOf(execute);
				if (idx !== -1) this._waitQueue.splice(idx, 1);
				reject(new CancelledError());
			};

			const execute = () => {
				signal?.removeEventListener("abort", onAbort);
				this.running++;
				// `release`, when given, must run BEFORE _releaseSlot(): releasing
				// the slot synchronously drains the next waiter, which may call
				// semaphore.acquire() immediately — if the permit hasn't actually
				// been freed yet (i.e. this ran after _releaseSlot instead of
				// before), that acquire can spuriously see none available and
				// reject even though one was about to free.
				const runTask = (release?: () => void) => {
					onDequeue?.(Date.now() - enqueuedAt);
					return task().then(
						(result) => {
							release?.();
							this._releaseSlot();
							resolve(result);
						},
						(err) => {
							release?.();
							this._releaseSlot();
							reject(err);
						},
					);
				};

				if (semaphore) {
					semaphore.acquire(signal).then(
						(release) => {
							// void: outcomes are routed to the outer resolve/reject inside runTask.
							void runTask(release);
						},
						(err) => {
							// The partition slot was granted but the global semaphore
							// rejected (queue full, or cancelled while waiting for a
							// permit) — release the slot we already
							// counted, or it leaks as a permanently phantom-running slot.
							// Report how long this attempt actually waited before being
							// told no; it never reached runTask's own onDequeue call.
							onDequeue?.(Date.now() - enqueuedAt);
							this._releaseSlot();
							reject(err);
						},
					);
				} else {
					// void: outcomes are routed to the outer resolve/reject inside runTask.
					void runTask();
				}
			};

			if (this.running < this.concurrency) {
				execute();
			} else if (this._waitQueue.length < this.maxQueueSize) {
				signal?.addEventListener("abort", onAbort, { once: true });
				this._waitQueue.push(execute);
			} else {
				reject(new QueueFullError(this.name, this._waitQueue.length, this.maxQueueSize));
			}
		});
	}

	/** Free a counted slot and hand it to the next waiter, if any. Every path
	 *  that decrements `running` — task success, task failure, and a rejected
	 *  semaphore acquire after the slot was already granted — must go through
	 *  this, or a slot leaks as permanently phantom-running. */
	private _releaseSlot(): void {
		this.running--;
		this._drainWaitQueue();
	}

	private _drainWaitQueue(): void {
		while (this.running < this.concurrency && this._waitQueue.length > 0) {
			const next = this._waitQueue.shift()!;
			next();
		}
	}
}

// ---------------------------------------------------------------------------
// Bulkhead registry — one bulkhead per partition
// ---------------------------------------------------------------------------

export interface BulkheadSnapshot {
	/** The partition this snapshot describes, named as in `CircuitSnapshot`. */
	partition: string;
	/** @deprecated Use `partition`; same value. Removed in 2.0. */
	name: string;
	running: number;
	queued: number;
	concurrency: number;
	maxQueueSize: number;
	/** Rate-limit tokens free right now. Present only when the partition has a
	 *  `rateLimit`; `0` while attempts are waiting for theirs. */
	tokens?: number;
	/** Epoch ms until which the partition sends nothing, after a `Retry-After`
	 *  (see `pauseOnRetryAfter`). Present only while the pause is active. */
	pausedUntil?: number;
}

export class BulkheadRegistry {
	private readonly partitions: PartitionRegistry<Bulkhead>;
	private readonly globalConfig: PartitionConfig;
	private readonly partitionConfig: PartitionLookup;
	private readonly semaphore?: Semaphore;

	constructor(
		globalConfig: PartitionConfig = {},
		partitionConfigs: Record<string, PartitionConfig> | PartitionLookup = {},
		ttlMs: number = DEFAULT_PARTITION_TTL_MS,
		semaphore?: Semaphore,
	) {
		this.globalConfig = globalConfig;
		this.partitionConfig =
			typeof partitionConfigs === "function" ? partitionConfigs : partitionLookup(partitionConfigs);
		this.semaphore = semaphore;
		this.partitions = new PartitionRegistry((name) => {
			const partitionConfig = this.partitionConfig(name) ?? {};
			const merged: PartitionConfig = {
				...this.globalConfig,
				...partitionConfig,
				rateLimit: mergeOptional(this.globalConfig.rateLimit, partitionConfig.rateLimit),
				pauseOnRetryAfter: mergeOptional(this.globalConfig.pauseOnRetryAfter, partitionConfig.pauseOnRetryAfter),
			};
			return new Bulkhead(name, merged);
		}, ttlMs);
	}

	get(partitionName: string): Bulkhead {
		return this.partitions.get(partitionName);
	}

	prune(): void {
		this.partitions.prune();
	}

	delete(partitionName: string): void {
		this.partitions.delete(partitionName);
	}

	getAll(): BulkheadSnapshot[] {
		const result: BulkheadSnapshot[] = [];
		for (const bh of this.partitions.values()) {
			const snapshot: BulkheadSnapshot = {
				partition: bh.name,
				name: bh.name,
				running: bh.runningCount,
				queued: bh.queueSize,
				concurrency: bh.concurrencyLimit,
				maxQueueSize: bh.maxQueueSizeLimit,
			};
			const tokens = bh.tokensAvailable;
			if (tokens !== undefined) snapshot.tokens = tokens;
			const pausedUntil = bh.pausedUntil;
			if (pausedUntil !== undefined) snapshot.pausedUntil = pausedUntil;
			result.push(snapshot);
		}
		return result;
	}

	getSemaphore(): Semaphore | undefined {
		return this.semaphore;
	}
}

/** Partition fields override the client-level ones one by one (the merge of
 *  `rateLimit`, `pauseOnRetryAfter` and `retryBudget`). `false` on either side
 *  opts the partition out; spreading it would keep the client's setting. */
export function mergeOptional<T extends object>(
	global: T | false | undefined,
	partition: T | false | undefined,
): T | undefined {
	if (partition === false || global === false) return undefined;
	if (!global && !partition) return undefined;
	return { ...global, ...partition } as T;
}
