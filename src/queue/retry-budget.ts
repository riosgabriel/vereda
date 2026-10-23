import { DEFAULT_MIN_RETRIES_PER_SEC, type PartitionLookup, type RetryBudgetConfig } from "../core/types.ts";
import { DEFAULT_PARTITION_TTL_MS, mergeOptional } from "./bulkhead.ts";
import { PartitionRegistry } from "./partition-registry.ts";

// ---------------------------------------------------------------------------
// Sliding window — fixed-size time buckets counting requests and retries
// ---------------------------------------------------------------------------

interface Bucket {
	/** Bucket start time (ms since epoch), used to determine expiry. */
	start: number;
	requests: number;
	retries: number;
}

const BUCKET_COUNT = 10;

class BudgetWindow {
	private readonly sizeMs: number;
	private readonly bucketMs: number;
	private buckets: Bucket[] = [];

	constructor(sizeMs: number) {
		this.sizeMs = sizeMs;
		this.bucketMs = Math.max(1, Math.floor(sizeMs / BUCKET_COUNT));
	}

	recordRequest(now: number): void {
		this.currentBucket(now).requests++;
	}

	recordRetry(now: number): void {
		this.currentBucket(now).retries++;
	}

	/** Requests and retries still inside the window at `now`. */
	totals(now: number): { requests: number; retries: number } {
		this.prune(now);
		let requests = 0;
		let retries = 0;
		for (const b of this.buckets) {
			requests += b.requests;
			retries += b.retries;
		}
		return { requests, retries };
	}

	/** True once every bucket has aged out: the window holds nothing to lose. */
	isEmpty(now: number): boolean {
		this.prune(now);
		return this.buckets.length === 0;
	}

	private currentBucket(now: number): Bucket {
		this.prune(now);
		const bucketStart = Math.floor(now / this.bucketMs) * this.bucketMs;
		const last = this.buckets[this.buckets.length - 1];
		if (last && last.start === bucketStart) return last;
		const bucket: Bucket = { start: bucketStart, requests: 0, retries: 0 };
		this.buckets.push(bucket);
		return bucket;
	}

	private prune(now: number): void {
		const cutoff = now - this.sizeMs;
		if (this.buckets.length > 0 && this.buckets[0]!.start < cutoff) {
			this.buckets = this.buckets.filter((b) => b.start >= cutoff);
		}
	}
}

// ---------------------------------------------------------------------------
// RetryBudget — one per partition
// ---------------------------------------------------------------------------

/** Caps retries to a fraction of a partition's recent traffic (as in gRPC and
 *  Finagle), so a failing host sees at most ≈ `1 + ratio` times its normal
 *  load instead of `1 + maxRetries` times. Inert when unconfigured. */
export class RetryBudget {
	private readonly config?: RetryBudgetConfig;
	private readonly window?: BudgetWindow;
	private activeTickets = 0;

	constructor(config?: RetryBudgetConfig) {
		this.config = config;
		if (config) this.window = new BudgetWindow(config.windowMs);
	}

	get enabled(): boolean {
		return this.window !== undefined;
	}

	/** Count a first attempt against the window. No-op when disabled. */
	recordRequest(now: number = Date.now()): void {
		this.window?.recordRequest(now);
	}

	/** Admit a retry and count it, or return false when the budget is spent.
	 *  Always true when disabled. */
	tryWithdraw(now: number = Date.now()): boolean {
		if (!this.window || !this.config) return true;
		const { requests, retries } = this.window.totals(now);
		const { ratio, windowMs, minRetriesPerSec = DEFAULT_MIN_RETRIES_PER_SEC } = this.config;
		// Strict `<`: with ratio 0 and no floor, nothing is ever retried.
		const allowed = Math.max(minRetriesPerSec * (windowMs / 1000), ratio * requests);
		if (retries >= allowed) return false;
		// Count only admitted retries, or a refusal would starve the partition.
		this.window.recordRetry(now);
		return true;
	}

	/** Mark a ticket as holding this budget until the returned function is
	 *  called (see `Bulkhead.retain`). The returned release is idempotent. */
	retain(): () => void {
		this.activeTickets++;
		let released = false;
		return () => {
			if (released) return;
			released = true;
			this.activeTickets--;
		};
	}

	/** Never while a live ticket holds it, nor while its window still counts
	 *  traffic: a fresh budget would forget the retries already spent. */
	isEvictable(now: number): boolean {
		if (this.activeTickets > 0) return false;
		return this.window === undefined || this.window.isEmpty(now);
	}
}

// ---------------------------------------------------------------------------
// RetryBudgetRegistry — one budget per partition, mirrors CircuitBreakerRegistry
// ---------------------------------------------------------------------------

export class RetryBudgetRegistry {
	private readonly partitions: PartitionRegistry<RetryBudget>;
	private readonly globalConfig?: RetryBudgetConfig;
	private readonly partitionConfig: PartitionLookup;

	constructor(
		globalConfig: RetryBudgetConfig | undefined,
		partitionConfig: PartitionLookup,
		ttlMs: number = DEFAULT_PARTITION_TTL_MS,
	) {
		this.globalConfig = globalConfig;
		this.partitionConfig = partitionConfig;
		this.partitions = new PartitionRegistry((name) => {
			const partitionConfig = this.partitionConfig(name)?.retryBudget;
			return new RetryBudget(mergeOptional(this.globalConfig, partitionConfig));
		}, ttlMs);
	}

	get(partitionName: string): RetryBudget {
		return this.partitions.get(partitionName);
	}

	prune(): void {
		this.partitions.prune();
	}
}
