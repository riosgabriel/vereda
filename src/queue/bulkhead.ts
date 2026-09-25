import { CancelledError, QueueFullError } from "../core/errors.ts";
import { DEFAULT_CONCURRENCY, DEFAULT_MAX_QUEUE_SIZE, type PartitionConfig } from "../core/types.ts";
import type { Semaphore } from "./semaphore.ts";

/** Default TTL (ms) before an idle partition registry entry (bulkhead or
 *  circuit breaker) is swept from its registry. Shared by both registries
 *  so the eviction policy stays in one place. */
export const DEFAULT_PARTITION_TTL_MS = 60_000;

export class Bulkhead {
	public readonly name: string;
	private readonly concurrency: number;
	private readonly maxQueueSize: number;
	private readonly _limitFirstAttempts: boolean;
	private running = 0;
	private readonly _waitQueue: Array<() => void> = [];

	constructor(name: string, config: PartitionConfig = {}) {
		this.name = name;
		this.concurrency = config.concurrency ?? DEFAULT_CONCURRENCY;
		this.maxQueueSize = config.maxQueueSize ?? DEFAULT_MAX_QUEUE_SIZE;
		this._limitFirstAttempts = config.limitFirstAttempts ?? false;
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
	name: string;
	running: number;
	queued: number;
	concurrency: number;
	maxQueueSize: number;
}

type BulkheadEntry = [Bulkhead, number];

export class BulkheadRegistry {
	private readonly bulkheads = new Map<string, BulkheadEntry>();
	private readonly ttlMs: number;
	private readonly globalConfig: PartitionConfig;
	private readonly partitionConfigs: Record<string, PartitionConfig>;
	private readonly sweepInterval: number;
	private readonly semaphore?: Semaphore;
	private callCounter = 0;

	constructor(
		globalConfig: PartitionConfig = {},
		partitionConfigs: Record<string, PartitionConfig> = {},
		ttlMs: number = DEFAULT_PARTITION_TTL_MS,
		semaphore?: Semaphore,
	) {
		this.ttlMs = ttlMs;
		this.globalConfig = globalConfig;
		this.partitionConfigs = partitionConfigs;
		this.sweepInterval = 10;
		this.semaphore = semaphore;
	}

	get(partitionName: string): Bulkhead {
		this.callCounter++;

		if (!this.bulkheads.has(partitionName)) {
			const partitionConfig = this.partitionConfigs[partitionName] ?? {};
			const merged: PartitionConfig = {
				...this.globalConfig,
				...partitionConfig,
			};
			this.bulkheads.set(partitionName, [new Bulkhead(partitionName, merged), Date.now()]);
		}
		const [bh] = this.bulkheads.get(partitionName)!;
		// Update last accessed time
		this.bulkheads.set(partitionName, [bh, Date.now()]);

		// Sweep stale entries periodically
		if (this.callCounter % this.sweepInterval === 0 || this.bulkheads.size > 100) {
			this.prune();
		}

		return bh;
	}

	prune(): void {
		const now = Date.now();
		for (const [key, [, lastAccessed]] of this.bulkheads) {
			if (now - lastAccessed > this.ttlMs) {
				this.bulkheads.delete(key);
			}
		}
	}

	delete(partitionName: string): void {
		this.bulkheads.delete(partitionName);
	}

	getAll(): BulkheadSnapshot[] {
		const result: BulkheadSnapshot[] = [];
		for (const [, [bh]] of this.bulkheads) {
			result.push({
				name: bh.name,
				running: bh.runningCount,
				queued: bh.queueSize,
				concurrency: bh.concurrencyLimit,
				maxQueueSize: bh.maxQueueSizeLimit,
			});
		}
		return result;
	}

	getSemaphore(): Semaphore | undefined {
		return this.semaphore;
	}
}
