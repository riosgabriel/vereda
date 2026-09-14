import type { AppError } from "../core/errors.js";
import {
	type CircuitBreakerConfig,
	DEFAULT_FAILURE_THRESHOLD,
	DEFAULT_HALF_OPEN_MAX_ATTEMPTS,
	DEFAULT_RESET_TIMEOUT_MS,
	type PartitionConfig,
} from "../core/types.js";
import { DEFAULT_PARTITION_TTL_MS } from "./bulkhead.js";
import { RETRIABLE_KINDS } from "./policy.js";

type CircuitState = "closed" | "open" | "half-open";

// ---------------------------------------------------------------------------
// Rolling window — fixed-size time buckets for the failure-percentage mode
// ---------------------------------------------------------------------------

interface Bucket {
	/** Bucket start time (ms since epoch), used to determine expiry. */
	start: number;
	total: number;
	failures: number;
}

const DEFAULT_BUCKET_COUNT = 10;

class RollingWindow {
	private readonly sizeMs: number;
	private readonly bucketMs: number;
	private buckets: Bucket[] = [];

	constructor(sizeMs: number, bucketCount: number = DEFAULT_BUCKET_COUNT) {
		this.sizeMs = sizeMs;
		this.bucketMs = Math.max(1, Math.floor(sizeMs / bucketCount));
	}

	recordSuccess(now: number = Date.now()): void {
		const bucket = this.currentBucket(now);
		bucket.total++;
	}

	recordFailure(now: number = Date.now()): void {
		const bucket = this.currentBucket(now);
		bucket.total++;
		bucket.failures++;
	}

	totalRequests(now: number = Date.now()): number {
		this.prune(now);
		return this.buckets.reduce((sum, b) => sum + b.total, 0);
	}

	failureRate(now: number = Date.now()): number {
		this.prune(now);
		const total = this.buckets.reduce((sum, b) => sum + b.total, 0);
		if (total === 0) return 0;
		const failures = this.buckets.reduce((sum, b) => sum + b.failures, 0);
		return (failures / total) * 100;
	}

	private currentBucket(now: number): Bucket {
		this.prune(now);
		const bucketStart = Math.floor(now / this.bucketMs) * this.bucketMs;
		const last = this.buckets[this.buckets.length - 1];
		if (last && last.start === bucketStart) {
			return last;
		}
		const bucket: Bucket = { start: bucketStart, total: 0, failures: 0 };
		this.buckets.push(bucket);
		return bucket;
	}

	private prune(now: number): void {
		const cutoff = now - this.sizeMs;
		this.buckets = this.buckets.filter((b) => b.start >= cutoff);
	}
}

// ---------------------------------------------------------------------------
// CircuitBreaker — one per partition
// ---------------------------------------------------------------------------

export class CircuitBreaker {
	private readonly partition: string;
	private readonly config: CircuitBreakerConfig;
	private readonly onStateChange?: (partition: string, state: "open" | "closed") => void;

	private state: CircuitState = "closed";
	private consecutiveFailures = 0;
	private openedAt = 0;
	private halfOpenInFlight = 0;
	private readonly window?: RollingWindow;

	constructor(
		partition: string,
		config: CircuitBreakerConfig = {},
		onStateChange?: (partition: string, state: "open" | "closed") => void,
	) {
		this.partition = partition;
		this.config = config;
		this.onStateChange = onStateChange;
		if (config.window) {
			this.window = new RollingWindow(config.window.sizeMs);
		}
	}

	/** Whether a request may proceed against this partition right now.
	 *  Always true when the breaker is disabled. Handles the open -> half-open
	 *  transition on `resetTimeoutMs` elapse, and reserves a half-open trial
	 *  slot atomically so concurrent callers don't over-admit trials. */
	canRequest(): boolean {
		if (!this.config.enabled) return true;

		if (this.state === "open") {
			const resetTimeoutMs = this.config.resetTimeoutMs ?? DEFAULT_RESET_TIMEOUT_MS;
			if (Date.now() - this.openedAt >= resetTimeoutMs) {
				this.state = "half-open";
				this.halfOpenInFlight = 0;
			} else {
				return false;
			}
		}

		if (this.state === "half-open") {
			const maxAttempts = this.config.halfOpenMaxAttempts ?? DEFAULT_HALF_OPEN_MAX_ATTEMPTS;
			if (this.halfOpenInFlight >= maxAttempts) {
				return false;
			}
			// Reserve the slot immediately (side-effecting) so two callers
			// arriving before either trial resolves can't both be admitted.
			this.halfOpenInFlight++;
			return true;
		}

		// closed
		return true;
	}

	/** Record a successful attempt outcome. No-op when disabled. */
	recordSuccess(): void {
		if (!this.config.enabled) return;

		if (this.state === "half-open") {
			this.halfOpenInFlight = Math.max(0, this.halfOpenInFlight - 1);
			this.state = "closed";
			this.resetCounters();
			this.onStateChange?.(this.partition, "closed");
			return;
		}

		if (this.state === "closed") {
			this.consecutiveFailures = 0;
			this.window?.recordSuccess();
		}
	}

	/** Record a failed attempt outcome. No-op when disabled or when the error
	 *  is not classified as a failure. */
	recordFailure(error: AppError): void {
		if (!this.config.enabled) return;

		const isFailure = this.config.isFailure ? this.config.isFailure(error) : RETRIABLE_KINDS.has(error.kind);
		if (!isFailure) return;

		if (this.state === "half-open") {
			this.halfOpenInFlight = Math.max(0, this.halfOpenInFlight - 1);
			this.state = "open";
			this.openedAt = Date.now();
			this.onStateChange?.(this.partition, "open");
			return;
		}

		if (this.state === "closed") {
			this.consecutiveFailures++;
			this.window?.recordFailure();
			if (this.evaluateTripCondition()) {
				this.state = "open";
				this.openedAt = Date.now();
				this.onStateChange?.(this.partition, "open");
			}
		}
	}

	private resetCounters(): void {
		this.consecutiveFailures = 0;
		this.halfOpenInFlight = 0;
	}

	private evaluateTripCondition(): boolean {
		const windowConfig = this.config.window;
		if (this.window && windowConfig) {
			return (
				this.window.totalRequests() >= windowConfig.minimumRequests &&
				this.window.failureRate() > windowConfig.failureRatePercent
			);
		}
		return this.consecutiveFailures >= (this.config.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD);
	}
}

// ---------------------------------------------------------------------------
// CircuitBreakerRegistry — one breaker per partition, mirrors BulkheadRegistry
// ---------------------------------------------------------------------------

type CircuitBreakerEntry = [CircuitBreaker, number];

export class CircuitBreakerRegistry {
	private readonly breakers = new Map<string, CircuitBreakerEntry>();
	private readonly ttlMs: number;
	private readonly globalConfig: CircuitBreakerConfig;
	private readonly partitionConfigs: Record<string, PartitionConfig>;
	private readonly sweepInterval: number;
	private readonly onStateChange?: (partition: string, state: "open" | "closed") => void;
	private callCounter = 0;

	constructor(
		globalConfig: CircuitBreakerConfig = {},
		partitionConfigs: Record<string, PartitionConfig> = {},
		ttlMs: number = DEFAULT_PARTITION_TTL_MS,
		onStateChange?: (partition: string, state: "open" | "closed") => void,
	) {
		this.ttlMs = ttlMs;
		this.globalConfig = globalConfig;
		this.partitionConfigs = partitionConfigs;
		this.sweepInterval = 10;
		this.onStateChange = onStateChange;
	}

	get(partitionName: string): CircuitBreaker {
		this.callCounter++;

		if (!this.breakers.has(partitionName)) {
			const partitionConfig = this.partitionConfigs[partitionName]?.circuitBreaker ?? {};
			const merged: CircuitBreakerConfig = {
				...this.globalConfig,
				...partitionConfig,
			};
			this.breakers.set(partitionName, [new CircuitBreaker(partitionName, merged, this.onStateChange), Date.now()]);
		}
		const [cb] = this.breakers.get(partitionName)!;
		// Update last accessed time
		this.breakers.set(partitionName, [cb, Date.now()]);

		// Sweep stale entries periodically
		if (this.callCounter % this.sweepInterval === 0 || this.breakers.size > 100) {
			this.prune();
		}

		return cb;
	}

	prune(): void {
		const now = Date.now();
		for (const [key, [, lastAccessed]] of this.breakers) {
			if (now - lastAccessed > this.ttlMs) {
				this.breakers.delete(key);
			}
		}
	}

	delete(partitionName: string): void {
		this.breakers.delete(partitionName);
	}
}
