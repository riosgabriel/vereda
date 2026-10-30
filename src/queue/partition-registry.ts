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
 *  the size trigger, which starts at `SWEEP_SIZE_THRESHOLD` entries. */
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
	/** Map size past which every `get` sweeps. Moves when a size-triggered
	 *  sweep finds nothing to evict, so live entries aren't scanned per call. */
	private sizeSweepTrigger = SWEEP_SIZE_THRESHOLD;

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
		if (this.callCounter % SWEEP_INTERVAL === 0 || this.entries.size > this.sizeSweepTrigger) {
			const before = this.entries.size;
			this.prune();
			this.adjustSizeSweepTrigger(before - this.entries.size);
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

	/** Called after each sweep from `get`, periodic or size-triggered, with how
	 *  many entries it removed; `this.entries.size` is the size after it.
	 *  Must leave `sizeSweepTrigger` at `SWEEP_SIZE_THRESHOLD` or above. */
	private adjustSizeSweepTrigger(removed: number): void {
		const size = this.entries.size;
		if (size <= SWEEP_SIZE_THRESHOLD) {
			this.sizeSweepTrigger = SWEEP_SIZE_THRESHOLD;
		} else if (removed === 0 && size > this.sizeSweepTrigger) {
			// Nothing was evictable: wait for the map to double before scanning it again.
			this.sizeSweepTrigger = size * 2;
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
