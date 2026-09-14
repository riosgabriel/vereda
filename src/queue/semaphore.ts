import { QueueFullError } from "../core/errors.js";
import { DEFAULT_GLOBAL_QUEUE_SIZE } from "../core/types.js";

/**
 * A counting semaphore that limits total concurrent executions across all
 * partitions (the global concurrency cap — decision D1, see
 * `ClientConfig.concurrency` / `DEFAULT_GLOBAL_CONCURRENCY` for the default).
 *
 * Each `acquire()` returns a `release` callback. When no permit is available
 * the caller is queued (up to `maxQueueSize`, see `ClientConfig.maxQueueSize` /
 * `DEFAULT_GLOBAL_QUEUE_SIZE`) and resolved when a permit is released.
 * Exceeding the queue limit rejects immediately with QueueFullError.
 */
export class Semaphore {
	private available: number;
	private readonly waitQueue: Array<() => void> = [];
	private readonly maxQueueSize: number;

	constructor(permits: number, maxQueueSize = DEFAULT_GLOBAL_QUEUE_SIZE) {
		this.available = permits;
		this.maxQueueSize = maxQueueSize;
	}

	/** Number of callers currently waiting for a permit. */
	get queueLength(): number {
		return this.waitQueue.length;
	}

	/** Number of permits currently free (not held by an in-flight request). */
	get availablePermits(): number {
		return this.available;
	}

	/** Acquire a permit. Resolves to a `release` function when granted. */
	acquire(): Promise<() => void> {
		if (this.available > 0) {
			this.available--;
			return Promise.resolve(() => this.release());
		}

		if (this.waitQueue.length >= this.maxQueueSize) {
			return Promise.reject(new QueueFullError("global", this.waitQueue.length, this.maxQueueSize));
		}

		return new Promise<() => void>((resolve) => {
			this.waitQueue.push(() => {
				this.available--;
				resolve(() => this.release());
			});
		});
	}

	private release(): void {
		this.available++;
		this._drain();
	}

	private _drain(): void {
		while (this.available > 0 && this.waitQueue.length > 0) {
			const next = this.waitQueue.shift()!;
			next();
		}
	}
}
