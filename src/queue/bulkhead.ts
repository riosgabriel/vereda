import { QueueFullError } from "../core/errors.js";
import { DEFAULT_CONCURRENCY, DEFAULT_MAX_QUEUE_SIZE, type PartitionConfig } from "../core/types.js";
import type { Semaphore } from "./semaphore.js";

type Task = () => Promise<void>;

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
	private queue: Task[] = [];
	private readonly _waitQueue: Array<() => void> = [];

	constructor(name: string, config: PartitionConfig = {}) {
		this.name = name;
		this.concurrency = config.concurrency ?? DEFAULT_CONCURRENCY;
		this.maxQueueSize = config.maxQueueSize ?? DEFAULT_MAX_QUEUE_SIZE;
		this._limitFirstAttempts = config.limitFirstAttempts ?? false;
	}

	get queueSize(): number {
		return this.queue.length;
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
	 *  partition slot and released before it (D4). */
	run<T>(task: () => Promise<T>, semaphore?: Semaphore): Promise<T> {
		return new Promise<T>((resolve, reject) => {
			const execute = () => {
				this.running++;
				const runTask = () =>
					task().then(
						(result) => {
							this.running--;
							this._drainWaitQueue();
							resolve(result);
						},
						(err) => {
							this.running--;
							this._drainWaitQueue();
							reject(err);
						},
					);

				if (semaphore) {
					semaphore.acquire().then((release) => {
						// void: outcomes are routed to the outer resolve/reject inside runTask.
						void runTask().finally(release);
					}, reject);
				} else {
					// void: outcomes are routed to the outer resolve/reject inside runTask.
					void runTask();
				}
			};

			if (this.running < this.concurrency) {
				execute();
			} else if (this._waitQueue.length < this.maxQueueSize) {
				this._waitQueue.push(execute);
			} else {
				reject(new QueueFullError(this.name, this._waitQueue.length, this.maxQueueSize));
			}
		});
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
