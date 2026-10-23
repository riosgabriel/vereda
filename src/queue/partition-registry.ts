/** What a registry needs to know about an entry before dropping it. Each
 *  entry owns its own rule (B12: never prune state that is still in use). */
export interface Evictable {
	isEvictable(now: number): boolean;
}

/** Default TTL (ms) before an idle entry is swept from a registry. One value
 *  for the bulkhead, circuit breaker and retry budget registries, so the
 *  eviction policy stays in one place. */
export const DEFAULT_PARTITION_TTL_MS = 60_000;

/** Sweep every this many `get` calls, or on any call once the map is past
 *  `SWEEP_SIZE_THRESHOLD` entries. */
const SWEEP_INTERVAL = 10;
const SWEEP_SIZE_THRESHOLD = 100;

/** One lazily created entry per partition, evicted once it has gone `ttlMs`
 *  without a `get` and its own `isEvictable` agrees. Shared by the bulkhead,
 *  circuit breaker and retry budget registries, which subclass it to supply
 *  how a partition's config is merged. */
export class PartitionRegistry<T extends Evictable> {
	private readonly entries = new Map<string, [T, number]>();
	private readonly create: (partitionName: string) => T;
	private readonly ttlMs: number;
	private callCounter = 0;

	constructor(create: (partitionName: string) => T, ttlMs: number = DEFAULT_PARTITION_TTL_MS) {
		this.create = create;
		this.ttlMs = ttlMs;
	}

	get(partitionName: string): T {
		this.callCounter++;
		const now = Date.now();

		let entry = this.entries.get(partitionName);
		if (!entry) {
			entry = [this.create(partitionName), now];
			this.entries.set(partitionName, entry);
		}
		entry[1] = now;

		// Sweep stale entries periodically
		if (this.callCounter % SWEEP_INTERVAL === 0 || this.entries.size > SWEEP_SIZE_THRESHOLD) {
			this.prune();
		}

		return entry[0];
	}

	prune(): void {
		const now = Date.now();
		for (const [key, [entry, lastAccessed]] of this.entries) {
			if (now - lastAccessed > this.ttlMs && entry.isEvictable(now)) {
				this.entries.delete(key);
			}
		}
	}

	delete(partitionName: string): void {
		this.entries.delete(partitionName);
	}

	/** Every live entry. Doesn't refresh last-access times, so observing a
	 *  partition never keeps it from being evicted. */
	*values(): IterableIterator<T> {
		for (const [entry] of this.entries.values()) yield entry;
	}
}
