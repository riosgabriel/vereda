import { EventEmitter } from "node:events";
import { BulkheadRegistry, type BulkheadSnapshot, DEFAULT_PARTITION_TTL_MS } from "../queue/bulkhead.js";
import { type CircuitBreaker, CircuitBreakerRegistry } from "../queue/circuit-breaker.js";
import { executeRequest, type MiddlewareFn } from "../queue/executor.js";
import { type RetryPolicyContext, shouldRetry } from "../queue/policy.js";
import { runRetryLoop } from "../queue/retry.js";
import { Semaphore } from "../queue/semaphore.js";
import { createTicket, type Ticket, type TicketController } from "../ticket/ticket.js";
import type { AppError } from "./errors.js";
import {
	CancelledError,
	CircuitOpenError,
	ConfigurationError,
	DeadlineExceededError,
	NetworkError,
	NO_TIMEOUT_CONFIGURED,
	RequestError,
	TimeoutError,
} from "./errors.js";
import { METRICS, type MetricsSink } from "./metrics.js";
import { nanoid } from "./nanoid.js";
import { redactUrl } from "./redact.js";
import type {
	ClientConfig,
	CloseOptions,
	LifecycleEventMap,
	Logger,
	ParseFn,
	PartitionConfig,
	RequestOptions,
	RetryConfig,
	TimeoutConfig,
} from "./types.js";
import { DEFAULT_GLOBAL_CONCURRENCY, DEFAULT_GLOBAL_QUEUE_SIZE, DEFAULT_MAX_RETRIES, isBoundedMs } from "./types.js";
import { validateConfig, validateRequestBody } from "./validate.js";

/** Pairs an in-flight ticket with its cleanup function so that
 *  resources (signal listeners, deadline timers) are released synchronously
 *  during shutdown instead of being left to fire-and-forget handlers. */
interface InflightTicket {
	ticket: Ticket<unknown>;
	cleanup: () => void;
}

export class HttpClient {
	private readonly config: ClientConfig;
	private readonly emitter = new EventEmitter();
	private readonly middlewares: MiddlewareFn[] = [];
	private readonly bulkheads: BulkheadRegistry;
	private readonly circuitBreakers: CircuitBreakerRegistry;
	private readonly partitionConfigs: Record<string, PartitionConfig>;
	private readonly logger: Logger | undefined;
	private readonly metrics: MetricsSink | undefined;
	private readonly redactQuery: boolean;
	private readonly customFetch: typeof globalThis.fetch | undefined;
	private _closed = false;
	private readonly _inflightTickets = new Set<InflightTicket>();

	private constructor(config: ClientConfig) {
		this.config = config;
		this.logger = config.logger;
		this.metrics = config.metrics;
		this.redactQuery = config.redactQuery !== false;
		this.customFetch = config.fetch;
		this.partitionConfigs = config.partitions ?? {};
		const semaphore = new Semaphore(
			config.concurrency ?? DEFAULT_GLOBAL_CONCURRENCY,
			config.maxQueueSize ?? DEFAULT_GLOBAL_QUEUE_SIZE,
		);
		this.bulkheads = new BulkheadRegistry({}, this.partitionConfigs, DEFAULT_PARTITION_TTL_MS, semaphore);
		this.circuitBreakers = new CircuitBreakerRegistry(
			config.circuitBreaker ?? {},
			this.partitionConfigs,
			DEFAULT_PARTITION_TTL_MS,
			(partition, state) => {
				if (state === "open") {
					this.emit("circuitOpen", { partition });
				} else {
					this.emit("circuitClose", { partition });
				}
			},
		);
	}

	static create(config: ClientConfig): HttpClient {
		validateConfig(config);
		return new HttpClient(config);
	}

	// ---------------------------------------------------------------------------
	// Middleware
	// ---------------------------------------------------------------------------

	use(middleware: MiddlewareFn): this {
		this.middlewares.push(middleware);
		return this;
	}

	// ---------------------------------------------------------------------------
	// Lifecycle events
	// ---------------------------------------------------------------------------

	on<K extends keyof LifecycleEventMap>(event: K, listener: (data: LifecycleEventMap[K]) => void): this {
		this.emitter.on(event, listener);
		return this;
	}

	off<K extends keyof LifecycleEventMap>(event: K, listener: (data: LifecycleEventMap[K]) => void): this {
		this.emitter.off(event, listener);
		return this;
	}

	// ---------------------------------------------------------------------------
	// Core request method
	// ---------------------------------------------------------------------------

	request<T>(url: string, options: RequestOptions<T> = {}): Ticket<T> {
		if (this._closed) {
			throw new ConfigurationError("client closed");
		}

		const startTime = Date.now();
		const ticketId = nanoid();
		const { ticket, controller } = createTicket<T>(ticketId);

		// Wire external cancellation: aborting options.signal cancels the ticket.
		// The listener is removed when the ticket reaches a terminal state to
		// prevent a leak on the caller's signal (#7).
		let externalAbortListener: (() => void) | undefined;
		if (options.signal) {
			if (options.signal.aborted) {
				ticket.cancel();
			} else {
				externalAbortListener = () => ticket.cancel();
				options.signal.addEventListener("abort", externalAbortListener, {
					once: true,
				});
			}
		}

		const cleanupExternalSignal = () => {
			if (externalAbortListener && options.signal) {
				options.signal.removeEventListener("abort", externalAbortListener);
				externalAbortListener = undefined;
			}
		};

		// Total deadline: a single unref'd timer that aborts the ticket signal
		// on expiry, cancelling in-flight attempts and breaking sleep (#R3).
		// Use the explicit partition if available for the merge; the resolved
		// partition (hostname) will be used for retries in _fireFirstAttempt.
		const timeoutConfig = this.mergeTimeout(options, options.partition);
		let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
		const cleanupDeadline = () => {
			if (deadlineTimer !== undefined) {
				clearTimeout(deadlineTimer);
				deadlineTimer = undefined;
			}
		};
		if (isBoundedMs(timeoutConfig.totalMs)) {
			deadlineTimer = setTimeout(() => {
				controller.abortSignal();
			}, timeoutConfig.totalMs);
			deadlineTimer.unref();
		}

		// Track this ticket for graceful shutdown. Store the entry so cleanup
		// can remove the same reference (Set.delete uses reference equality).
		const entry: InflightTicket = {
			ticket: ticket as Ticket<unknown>,
			cleanup: () => {},
		};

		// Combined cleanup: external signal + deadline timer + inflight tracking
		entry.cleanup = () => {
			cleanupExternalSignal();
			cleanupDeadline();
			this._inflightTickets.delete(entry);
		};

		this._inflightTickets.add(entry);

		// Fire and forget — first attempt runs immediately; queued if slow/failed
		this._fireFirstAttempt(
			url,
			options as RequestOptions<unknown>,
			ticket as Ticket<unknown>,
			controller as TicketController<unknown>,
			entry.cleanup,
			startTime,
		).catch((err: unknown) => {
			// A pre-typed RequestError (e.g. QueueFullError from the global
			// semaphore acquire in _fireFirstAttempt) is an expected, well-typed
			// error — preserve it as-is instead of demoting it to a generic
			// NetworkError. Anything else is a genuinely unexpected throw.
			const error =
				err instanceof RequestError
					? err
					: new NetworkError(err instanceof Error ? err.message : "Unexpected error", { cause: err });
			const durationMs = Date.now() - startTime;
			this.emit("failure", {
				ticketId: ticket.id,
				url: this.logUrl(url),
				attempts: 1,
				durationMs,
				queuedMs: 0,
				error,
			});
			if (ticket.status.state !== "done" && !ticket.isCancelled) {
				controller.markDone({ success: false, error } as never);
			}
			entry.cleanup();
		});

		return ticket;
	}

	private async _fireFirstAttempt(
		url: string,
		options: RequestOptions<unknown>,
		ticket: Ticket<unknown>,
		controller: TicketController<unknown>,
		cleanup: () => void,
		startTime: number,
	): Promise<void> {
		// Resolve URL and partition inside the async path so relative URLs
		// without a baseUrl surface as ticket errors instead of throwing.
		let fullUrl: string;
		let partitionName: string;
		try {
			fullUrl = this.resolveUrl(url);
			partitionName = options.partition ?? new URL(fullUrl).host;
		} catch (err) {
			const error = new NetworkError(err instanceof Error ? err.message : "Invalid URL", {
				cause: err,
			});
			const durationMs = Date.now() - startTime;
			this.emit("failure", {
				ticketId: ticket.id,
				url: this.logUrl(url),
				attempts: 1,
				durationMs,
				queuedMs: 0,
				error,
			});
			controller.markDone({ success: false, error } as never);
			cleanup();
			return;
		}

		// Validate the body early in the async path so an unusable body (a raw
		// ReadableStream) surfaces as a ticket ConfigurationError, not a throw.
		try {
			validateRequestBody(options.body);
		} catch (err) {
			const error = err as ConfigurationError;
			const durationMs = Date.now() - startTime;
			this.emit("failure", {
				ticketId: ticket.id,
				url: this.logUrl(url),
				attempts: 1,
				durationMs,
				queuedMs: 0,
				error,
			});
			controller.markDone({ success: false, error } as never);
			cleanup();
			return;
		}

		const timeoutConfig = this.mergeTimeout(options, partitionName);
		const retryConfig = this.mergeRetry(options, partitionName);
		const bulkhead = this.bulkheads.get(partitionName);
		const displayUrl = this.logUrl(fullUrl);

		this.emit("request", {
			ticketId: ticket.id,
			url: displayUrl,
			method: options.method ?? "GET",
			partition: partitionName,
		});
		this.logger?.info("Request initiated", {
			ticketId: ticket.id,
			url: displayUrl,
			method: options.method ?? "GET",
			partition: partitionName,
		});

		const breaker = this.circuitBreakers.get(partitionName);
		if (!breaker.canRequest()) {
			const error = new CircuitOpenError(partitionName);
			const durationMs = Date.now() - startTime;
			this.emit("failure", {
				ticketId: ticket.id,
				url: displayUrl,
				attempts: 1,
				durationMs,
				queuedMs: 0,
				error,
			});
			controller.markDone({ success: false, error } as never);
			cleanup();
			return;
		}

		// The global semaphore limits total concurrent executions across all
		// partitions. It is acquired for every attempt (including the first),
		// while the per-partition bulkhead slot only applies to retries (D4).
		const semaphore = this.bulkheads.getSemaphore();
		const execute = () =>
			executeRequest(
				{
					url: fullUrl,
					options,
					timeoutConfig,
					retryConfig,
					signal: ticket.signal,
					attempt: 0,
					ticketId: ticket.id,
					partition: partitionName,
					fetch: this.customFetch,
				},
				this.middlewares,
			);

		// When partition.limitFirstAttempts is enabled (R6), the first attempt
		// also goes through the per-partition bulkhead. Otherwise it bypasses
		// the partition slot entirely (D4). The global semaphore is always
		// acquired for every attempt — bulkhead.run() acquires it internally
		// when passed, so the task itself must not acquire it a second time.
		const usePartitionBulkhead = bulkhead.limitFirstAttempts;
		let queuedMs = 0;
		let result: Awaited<ReturnType<typeof execute>>;
		if (usePartitionBulkhead) {
			result = await bulkhead.run(execute, semaphore, (ms) => {
				queuedMs = ms;
			});
		} else if (semaphore) {
			const enqueuedAt = Date.now();
			result = await semaphore.acquire().then((release) => {
				queuedMs = Date.now() - enqueuedAt;
				return execute().finally(release);
			});
		} else {
			result = await execute();
		}

		switch (result.kind) {
			case "success": {
				breaker.recordSuccess();
				const durationMs = Date.now() - startTime;
				const statusCode = result.result.success ? result.result.raw.status : 0;
				this.emit("success", {
					ticketId: ticket.id,
					url: displayUrl,
					attempts: 1,
					durationMs,
					queuedMs,
					statusCode,
				});
				this.logger?.info("Request succeeded", {
					ticketId: ticket.id,
					url: displayUrl,
				});
				controller.markDone(result.result);
				cleanup();
				return;
			}

			case "cancelled": {
				const durationMs = Date.now() - startTime;
				this.emit("cancelled", {
					ticketId: ticket.id,
					url: displayUrl,
					attempts: 1,
					durationMs,
				});
				if (!ticket.isCancelled && isBoundedMs(timeoutConfig.totalMs)) {
					controller.markDone({
						success: false,
						error: new DeadlineExceededError(url, timeoutConfig.totalMs),
					} as never);
				} else {
					controller.markDone({
						success: false,
						error: new CancelledError(),
					} as never);
				}
				cleanup();
				return;
			}

			case "error":
				// Record the raw attempt outcome against the circuit breaker
				// regardless of what the retry policy decides to do with it.
				breaker.recordFailure(result.error);
				// Apply the unified retry gate (default policy + retryWhen). Errors
				// that fail it (e.g. ValidationError, HttpError) resolve immediately.
				if (this.vetoed(retryConfig, result.error, 0, options, ticket, controller, url, startTime, queuedMs)) {
					cleanup();
					return;
				}
				// maxRetries=0: no retries configured, surface the raw error immediately
				// without entering the bulkhead (which would waste a slot for no work).
				{
					const effectiveMaxRetries = retryConfig.maxRetries ?? DEFAULT_MAX_RETRIES;
					if (effectiveMaxRetries === 0) {
						const durationMs = Date.now() - startTime;
						this.emit("failure", {
							ticketId: ticket.id,
							url: displayUrl,
							attempts: 1,
							durationMs,
							queuedMs,
							error: result.error,
						});
						controller.markDone({
							success: false,
							error: result.error,
						} as never);
						cleanup();
						return;
					}
				}
				controller.markQueued();
				this._scheduleInBulkhead(
					ticket,
					controller,
					url,
					displayUrl,
					options,
					timeoutConfig,
					retryConfig,
					partitionName,
					bulkhead,
					breaker,
					result.error,
					cleanup,
					startTime,
					queuedMs,
				);
				return;

			case "timeout": {
				const error = new TimeoutError(url, timeoutConfig.attemptMs ?? NO_TIMEOUT_CONFIGURED);
				// Record the raw attempt outcome against the circuit breaker
				// regardless of what the retry policy decides to do with it.
				breaker.recordFailure(error);
				if (this.vetoed(retryConfig, error, 0, options, ticket, controller, url, startTime, queuedMs)) {
					cleanup();
					return;
				}
				// maxRetries=0: surface timeout immediately without entering the bulkhead
				{
					const effectiveMaxRetries = retryConfig.maxRetries ?? DEFAULT_MAX_RETRIES;
					if (effectiveMaxRetries === 0) {
						const durationMs = Date.now() - startTime;
						this.emit("failure", {
							ticketId: ticket.id,
							url: this.logUrl(url),
							attempts: 1,
							durationMs,
							queuedMs,
							error,
						});
						controller.markDone({ success: false, error } as never);
						cleanup();
						return;
					}
				}
				controller.markQueued();
				this._scheduleInBulkhead(
					ticket,
					controller,
					url,
					displayUrl,
					options,
					timeoutConfig,
					retryConfig,
					partitionName,
					bulkhead,
					breaker,
					error,
					cleanup,
					startTime,
					queuedMs,
				);
				return;
			}
		}
	}

	/** Apply the unified retry gate after the first attempt failed (attempt 0).
	 *  Returns true if the request must NOT be retried — the ticket is resolved
	 *  with the raw error and must not be queued. */
	private vetoed(
		retryConfig: RetryConfig,
		error: AppError,
		attempt: number,
		options: RequestOptions<unknown>,
		ticket: Ticket<unknown>,
		controller: TicketController<unknown>,
		url: string,
		startTime: number,
		queuedMs: number,
	): boolean {
		const ctx: RetryPolicyContext = {
			method: options.method ?? "GET",
			headers: options.headers,
			idempotent: retryConfig.idempotent,
		};
		if (!shouldRetry(error, attempt, ctx, retryConfig.retryWhen)) {
			const durationMs = Date.now() - startTime;
			this.emit("failure", {
				ticketId: ticket.id,
				url,
				attempts: 1,
				durationMs,
				queuedMs,
				error,
			});
			controller.markDone({ success: false, error } as never);
			return true;
		}
		return false;
	}

	private _scheduleInBulkhead(
		ticket: Ticket<unknown>,
		controller: TicketController<unknown>,
		url: string,
		displayUrl: string,
		options: RequestOptions<unknown>,
		timeoutConfig: TimeoutConfig,
		retryConfig: RetryConfig,
		partitionName: string,
		bulkhead: ReturnType<BulkheadRegistry["get"]>,
		breaker: CircuitBreaker,
		firstError: AppError,
		cleanup: () => void,
		startTime: number,
		initialQueuedMs: number,
	): void {
		this.logger?.info("Request queued for retry", {
			ticketId: ticket.id,
			url: displayUrl,
			partition: partitionName,
		});

		// Run the retry loop directly — each attempt inside the loop acquires its
		// own bulkhead slot via bulkhead.run() so other tickets are not blocked
		// for the entire retry lifetime (#5, D4). QueueFullError from the loop
		// is caught here and surfaced as a terminal ticket failure.
		runRetryLoop({
			url,
			requestOptions: options,
			timeoutConfig,
			retryConfig,
			ticket,
			controller,
			middleware: this.middlewares,
			bulkhead,
			semaphore: this.bulkheads.getSemaphore(),
			circuitBreaker: breaker,
			partition: partitionName,
			firstError,
			initialQueuedMs,
			fetch: this.customFetch,
			onRetry: (attempt, delayMs, error) => {
				this.emit("retry", {
					ticketId: ticket.id,
					url: displayUrl,
					attempt,
					delayMs,
					error,
				});
			},
			onSuccess: (statusCode, attempts, queuedMs) => {
				const durationMs = Date.now() - startTime;
				this.emit("success", {
					ticketId: ticket.id,
					url: displayUrl,
					attempts,
					durationMs,
					queuedMs,
					statusCode,
				});
			},
			onFailure: (error, attempts, queuedMs) => {
				const durationMs = Date.now() - startTime;
				this.emit("failure", {
					ticketId: ticket.id,
					url: displayUrl,
					attempts,
					durationMs,
					queuedMs,
					error,
				});
				this.logger?.warn("Request failed after retries", {
					ticketId: ticket.id,
					url: displayUrl,
					error: error.message,
				});
			},
			onCancelled: (attempts) => {
				const durationMs = Date.now() - startTime;
				this.emit("cancelled", {
					ticketId: ticket.id,
					url: displayUrl,
					attempts,
					durationMs,
				});
			},
			onCleanup: cleanup,
		}).catch((err: unknown) => {
			// A pre-typed RequestError (e.g. QueueFullError, already marked done
			// inside runRetryLoop before it re-throws) is preserved as-is.
			// Anything else is a genuinely unexpected throw. Either way, markDone
			// is only called if the ticket isn't already resolved — covers both
			// the "already marked done inside the loop" case and a genuine bug.
			const error =
				err instanceof RequestError
					? err
					: new NetworkError(err instanceof Error ? err.message : "Queue error", { cause: err });
			this.emit("failure", {
				ticketId: ticket.id,
				url: displayUrl,
				attempts: 1,
				durationMs: Date.now() - startTime,
				queuedMs: initialQueuedMs,
				error,
			});
			if (ticket.status.state !== "done" && !ticket.isCancelled) {
				controller.markDone({ success: false, error } as never);
			}
			cleanup();
		});
	}

	// ---------------------------------------------------------------------------
	// Convenience methods
	// ---------------------------------------------------------------------------

	/** GET request with JSON parsing. */
	get<T>(url: string, options: Omit<RequestOptions<T>, "method"> = {}): Ticket<T> {
		return this.request(url, { ...options, method: "GET" });
	}

	/** HEAD request. */
	head<T>(url: string, options: Omit<RequestOptions<T>, "method"> = {}): Ticket<T> {
		return this.request<T>(url, { ...options, method: "HEAD" });
	}

	/** OPTIONS request. */
	options<T>(url: string, options: Omit<RequestOptions<T>, "method"> = {}): Ticket<T> {
		return this.request<T>(url, { ...options, method: "OPTIONS" });
	}

	/** Parse JSON response body without validation. */
	json<T>(): ParseFn<T> {
		return (data: unknown): T => data as T;
	}

	post<T>(
		url: string,
		body?: BodyInit | (() => BodyInit),
		options: Omit<RequestOptions<T>, "method" | "body"> = {},
	): Ticket<T> {
		return this.request<T>(url, { ...options, method: "POST", body });
	}

	put<T>(
		url: string,
		body?: BodyInit | (() => BodyInit),
		options: Omit<RequestOptions<T>, "method" | "body"> = {},
	): Ticket<T> {
		return this.request<T>(url, { ...options, method: "PUT", body });
	}

	patch<T>(
		url: string,
		body?: BodyInit | (() => BodyInit),
		options: Omit<RequestOptions<T>, "method" | "body"> = {},
	): Ticket<T> {
		return this.request<T>(url, { ...options, method: "PATCH", body });
	}

	delete<T>(url: string, options: Omit<RequestOptions<T>, "method"> = {}): Ticket<T> {
		return this.request<T>(url, { ...options, method: "DELETE" });
	}

	// ---------------------------------------------------------------------------
	// Partition snapshots
	// ---------------------------------------------------------------------------

	/** Return a snapshot of all active bulkhead partitions.
	 *  Each entry includes the partition name, running/queued counts,
	 *  and configured concurrency/maxQueueSize limits. */
	partitions(): BulkheadSnapshot[] {
		return this.bulkheads.getAll();
	}

	// ---------------------------------------------------------------------------
	// Graceful shutdown
	// ---------------------------------------------------------------------------

	/** Close the client. New requests throw `ConfigurationError("client closed")`.
	 *  When `drain` is true, in-flight tickets are awaited up to `timeoutMs`
	 *  before the promise resolves, then remaining tickets are cancelled.
	 *  When `drain` is false (default), all in-flight tickets are cancelled
	 *  immediately.
	 *
	 *  `timeoutMs` is required when `drain` is true to prevent indefinite
	 *  hangs — use a value that fits your shutdown budget. */
	async close(opts?: CloseOptions): Promise<void> {
		if (this._closed) return; // idempotent
		this._closed = true;

		if (opts?.drain && (!opts.timeoutMs || opts.timeoutMs <= 0)) {
			throw new ConfigurationError("close({ drain: true }) requires a positive timeoutMs");
		}
		const { drain = false, timeoutMs = 0 } = opts ?? {};
		const entries = [...this._inflightTickets];

		if (!drain || entries.length === 0) {
			// Cancel all in-flight immediately
			for (const entry of entries) {
				entry.cleanup();
				entry.ticket.cancel();
			}
			this._inflightTickets.clear();
			return;
		}

		// Drain: wait for all to resolve, up to timeoutMs
		const done = Promise.all(entries.map((e) => e.ticket.toPromise()));
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeout = new Promise<void>((resolve) => {
			timer = setTimeout(resolve, timeoutMs);
			timer.unref();
		});
		await Promise.race([done, timeout]);
		// Cancel any remaining in-flight tickets and cleanup
		for (const entry of this._inflightTickets) {
			entry.cleanup();
			entry.ticket.cancel();
		}
		// Clear the timeout timer if tickets resolved first
		if (timer !== undefined) {
			clearTimeout(timer);
		}

		this._inflightTickets.clear();
	}

	// ---------------------------------------------------------------------------
	// Helpers
	// ---------------------------------------------------------------------------

	private resolveUrl(url: string): string {
		if (this.config.baseUrl) {
			return new URL(url, this.config.baseUrl).toString();
		}
		return url;
	}

	private mergeTimeout(options: RequestOptions<unknown>, partitionName?: string): TimeoutConfig {
		const partitionConfig = partitionName ? this.partitionConfigs[partitionName] : undefined;
		return {
			...this.config.timeout,
			...partitionConfig?.timeout,
			...options.timeout,
		};
	}

	private mergeRetry(options: RequestOptions<unknown>, partitionName?: string): RetryConfig {
		const partitionConfig = partitionName ? this.partitionConfigs[partitionName] : undefined;
		return {
			...this.config.retry,
			...partitionConfig?.retry,
			...options.retry,
		};
	}

	/** Returns the URL for logging, redacted if redactQuery is enabled. */
	private logUrl(url: string): string {
		return this.redactQuery ? redactUrl(url) : url;
	}

	private emit<K extends keyof LifecycleEventMap>(event: K, data: LifecycleEventMap[K]): void {
		this.emitter.emit(event, data);

		// Emit metrics if a sink is configured
		if (this.metrics) {
			const e = event as string;
			if (e === "request") {
				const d = data as LifecycleEventMap["request"];
				this.metrics.counter(METRICS.REQUESTS, 1, {
					partition: d.partition,
					method: d.method,
				});
				this.metrics.gauge(METRICS.IN_FLIGHT, this._inflightTickets.size);
				this.emitQueueDepthGauges();
			} else if (e === "retry") {
				const d = data as LifecycleEventMap["retry"];
				this.metrics.counter(METRICS.RETRIES, 1, { kind: d.error.kind });
			} else if (e === "success" || e === "failure" || e === "cancelled") {
				const d = data as LifecycleEventMap["success"] | LifecycleEventMap["failure"] | LifecycleEventMap["cancelled"];
				const kind =
					e === "success" ? "success" : e === "failure" ? (d as LifecycleEventMap["failure"]).error.kind : "cancelled";
				this.metrics.histogram(METRICS.DURATION, d.durationMs, { kind });
				this.metrics.gauge(METRICS.IN_FLIGHT, this._inflightTickets.size);
				this.emitQueueDepthGauges();
			} else if (e === "circuitOpen") {
				const d = data as LifecycleEventMap["circuitOpen"];
				this.metrics.counter(METRICS.CIRCUIT_OPEN, 1, { partition: d.partition });
			}
		}
	}

	/** Push current queue-depth gauges: per-partition bulkhead backlog and the
	 *  global semaphore backlog (the D1 cap devs most need visibility into). */
	private emitQueueDepthGauges(): void {
		if (!this.metrics) return;
		for (const snapshot of this.bulkheads.getAll()) {
			this.metrics.gauge(METRICS.QUEUE_DEPTH, snapshot.queued, { partition: snapshot.name });
		}
		const semaphore = this.bulkheads.getSemaphore();
		if (semaphore) {
			this.metrics.gauge(METRICS.GLOBAL_QUEUE_DEPTH, semaphore.queueLength);
		}
	}
}

/** Parse JSON response body without validation.
 *  Useful when you just need the raw parsed JSON object/array.
 *  Unlike `parse` with Zod, this does not validate the shape. */
export function json<T>(): ParseFn<T> {
	return (data: unknown): T => data as T;
}
