import { buildBackoffFn, DEFAULT_MAX_DELAY_MS } from "../core/backoff.js";
import type { AppError } from "../core/errors.js";
import {
	CancelledError,
	CircuitOpenError,
	DeadlineExceededError,
	MaxRetriesExceededError,
	NO_TIMEOUT_CONFIGURED,
	QueueFullError,
	RetryableStatusError,
	TimeoutError,
} from "../core/errors.js";
import {
	type BackoffOptions,
	DEFAULT_MAX_RETRIES,
	isBoundedMs,
	type RequestOptions,
	type RetryConfig,
	type TimeoutConfig,
} from "../core/types.js";
import type { Ticket, TicketController } from "../ticket/ticket.js";
import type { Bulkhead } from "./bulkhead.js";
import type { CircuitBreaker } from "./circuit-breaker.js";
import { executeRequest, type MiddlewareFn } from "./executor.js";
import { type RetryPolicyContext, shouldRetry } from "./policy.js";
import type { Semaphore } from "./semaphore.js";

export interface RetryJobOptions {
	url: string;
	requestOptions: RequestOptions<unknown>;
	timeoutConfig: TimeoutConfig;
	retryConfig: RetryConfig;
	ticket: Ticket<unknown>;
	controller: TicketController<unknown>;
	middleware: MiddlewareFn[];
	/** Per-attempt bulkhead for retry scheduling. */
	bulkhead: Bulkhead;
	/** Global concurrency semaphore acquired after the partition slot (D4). */
	semaphore?: Semaphore;
	/** Per-partition circuit breaker. Inert unless configured/enabled. */
	circuitBreaker: CircuitBreaker;
	/** Partition name, used to construct CircuitOpenError when the breaker is open. */
	partition: string;
	/** The error from the first attempt (fired client-side before queuing). */
	firstError: AppError;
	/** Ms the first attempt spent waiting for a bulkhead/semaphore permit,
	 *  carried over so the final queuedMs reported to the client covers the
	 *  whole ticket lifetime, not just the retries run inside this loop. */
	initialQueuedMs: number;
	onRetry?: (attempt: number, delayMs: number, error: AppError) => void;
	/** Called on success so the client can emit the success event with the
	 *  response status code, the total attempt count, and the cumulative ms
	 *  spent waiting for a bulkhead/semaphore permit across all attempts. */
	onSuccess?: (statusCode: number, attempts: number, queuedMs: number) => void;
	/** Called on failure (exhausted retries or policy veto inside the loop)
	 *  so the client can emit the failure event. `queuedMs` is cumulative
	 *  across all attempts made so far. */
	onFailure?: (error: AppError, attempts: number, queuedMs: number) => void;
	/** Called on cancellation (user cancel, deadline, or external signal)
	 *  so the client can emit the cancelled event. `queuedMs` is cumulative
	 *  across all attempts made so far. */
	onCancelled?: (attempts: number, queuedMs: number) => void;
	/** Called before markDone to clean up external resources (e.g. signal listeners). */
	onCleanup?: () => void;
	/** Custom fetch function. Falls back to globalThis.fetch. */
	fetch?: typeof globalThis.fetch;
}

export async function runRetryLoop(job: RetryJobOptions): Promise<void> {
	const {
		url,
		requestOptions,
		timeoutConfig,
		retryConfig,
		ticket,
		controller,
		middleware,
		bulkhead,
		semaphore,
		circuitBreaker,
		partition,
		firstError,
		initialQueuedMs,
		onRetry,
		onSuccess,
		onFailure,
		onCancelled,
		onCleanup,
		fetch: customFetch,
	} = job;

	const maxRetries = retryConfig.maxRetries ?? DEFAULT_MAX_RETRIES;
	const backoffFn = buildBackoffFn(retryConfig.backoff);
	const backoffCap =
		retryConfig.backoff && typeof retryConfig.backoff === "object"
			? ((retryConfig.backoff as BackoffOptions).maxDelayMs ?? DEFAULT_MAX_DELAY_MS)
			: DEFAULT_MAX_DELAY_MS;

	let lastError: AppError = firstError;
	let totalAttempts = 1; // first attempt already fired client-side
	let totalQueuedMs = initialQueuedMs; // cumulative bulkhead/semaphore wait across all attempts

	for (let attempt = 0; attempt < maxRetries; attempt++) {
		if (ticket.isCancelled) {
			onCleanup?.();
			onCancelled?.(totalAttempts, totalQueuedMs);
			controller.markDone({
				success: false,
				error: new CancelledError(),
			} as never);
			return;
		}

		if (!circuitBreaker.canRequest()) {
			onCleanup?.();
			const error = new CircuitOpenError(partition);
			onFailure?.(error, totalAttempts, totalQueuedMs);
			controller.markDone({ success: false, error } as never);
			return;
		}

		// Consult the default policy + retryWhen for every retry iteration.
		// The first attempt was already vetted at queue time (before the bulkhead),
		// but each retry within the bulkhead must pass the same gate so that
		// a user-provided retryWhen correctly limits retries to N+1 attempts total.
		const ctx: RetryPolicyContext = {
			method: requestOptions.method ?? "GET",
			headers: requestOptions.headers,
			idempotent: retryConfig.idempotent,
		};
		if (!shouldRetry(lastError, attempt, ctx, retryConfig.retryWhen)) {
			onCleanup?.();
			onFailure?.(lastError, totalAttempts, totalQueuedMs);
			controller.markDone({ success: false, error: lastError } as never);
			return;
		}

		// All retries get backoff. Every retry is gated by the policy check above.
		const delayMs = resolveRetryDelay(lastError, backoffFn, attempt, backoffCap);
		onRetry?.(attempt, delayMs, lastError);
		controller.markRetrying(attempt, delayMs);

		try {
			await sleep(delayMs, ticket.signal);
		} catch {
			// The deadline timer aborts the ticket signal. Distinguish deadline from
			// user cancellation: deadline only aborts the signal (abortSignal()),
			// while user cancellation sets _cancelled = true via cancel().
			onCleanup?.();
			if (!ticket.isCancelled && isBoundedMs(timeoutConfig.totalMs)) {
				const error = new DeadlineExceededError(url, timeoutConfig.totalMs);
				onFailure?.(error, totalAttempts, totalQueuedMs);
				controller.markDone({
					success: false,
					error,
				} as never);
			} else {
				onCancelled?.(totalAttempts, totalQueuedMs);
				controller.markDone({
					success: false,
					error: new CancelledError(),
				} as never);
			}
			return;
		}

		if (ticket.isCancelled) {
			onCleanup?.();
			onCancelled?.(totalAttempts, totalQueuedMs);
			controller.markDone({
				success: false,
				error: new CancelledError(),
			} as never);
			return;
		}

		totalAttempts++;

		// Per-attempt bulkhead scheduling: each retry acquires its own slot,
		// releases it after execution, so other tickets aren't blocked (#5, D4).
		// The global semaphore is acquired after the partition slot (D4).
		let result: Awaited<ReturnType<typeof executeRequest>>;
		try {
			result = await bulkhead.run(
				() =>
					executeRequest(
						{
							url,
							options: requestOptions,
							timeoutConfig,
							retryConfig,
							signal: ticket.signal,
							attempt: attempt + 1,
							ticketId: ticket.id,
							partition: bulkhead.name,
							fetch: customFetch,
						},
						middleware,
					),
				semaphore,
				(queuedMs) => {
					totalQueuedMs += queuedMs;
				},
			);
		} catch (err) {
			if (err instanceof QueueFullError) {
				// Queue is at capacity — mark done and let the error propagate to the
				// client which handles QueueFullError emission and cleanup.
				onCleanup?.();
				controller.markDone({ success: false, error: err } as never);
				throw err;
			}
			throw err;
		}

		switch (result.kind) {
			case "success": {
				circuitBreaker.recordSuccess();
				onCleanup?.();
				if (result.result.success) {
					onSuccess?.(result.result.raw.status, totalAttempts, totalQueuedMs);
				}
				controller.markDone(result.result);
				return;
			}

			case "cancelled":
				onCleanup?.();
				if (!ticket.isCancelled && isBoundedMs(timeoutConfig.totalMs)) {
					const error = new DeadlineExceededError(url, timeoutConfig.totalMs);
					onFailure?.(error, totalAttempts, totalQueuedMs);
					controller.markDone({
						success: false,
						error,
					} as never);
				} else {
					onCancelled?.(totalAttempts, totalQueuedMs);
					controller.markDone({
						success: false,
						error: new CancelledError(),
					} as never);
				}
				return;

			case "timeout":
				lastError = new TimeoutError(url, timeoutConfig.attemptMs ?? NO_TIMEOUT_CONFIGURED);
				circuitBreaker.recordFailure(lastError);
				break;

			case "error":
				lastError = result.error;
				circuitBreaker.recordFailure(lastError);
				break;
		}
	}

	if (maxRetries === 0) {
		// Zero retries configured/executed — surface the underlying error raw,
		// never wrapped in MaxRetriesExceededError.
		onCleanup?.();
		onFailure?.(lastError, totalAttempts, totalQueuedMs);
		controller.markDone({ success: false, error: lastError } as never);
		return;
	}

	// All retries exhausted — total attempts = 1 (first) + maxRetries (loop)
	totalAttempts = 1 + maxRetries;
	onCleanup?.();
	const exhaustedError = new MaxRetriesExceededError(totalAttempts, lastError);
	onFailure?.(exhaustedError, totalAttempts, totalQueuedMs);
	controller.markDone({
		success: false,
		error: exhaustedError,
	} as never);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(signal.reason ?? new DOMException("The operation was aborted", "AbortError"));
			return;
		}
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			reject(signal?.reason ?? new DOMException("The operation was aborted", "AbortError"));
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

/** Resolve the delay before a retry (decision D3): a Retry-After-derived
 *  `retryAfterMs` wins when present (capped at `cap`, no jitter), otherwise
 *  the configured backoff drives the delay. */
function resolveRetryDelay(
	lastError: AppError,
	backoffFn: (attempt: number) => number,
	attempt: number,
	cap: number,
): number {
	if (lastError instanceof RetryableStatusError && lastError.retryAfterMs !== undefined) {
		return Math.min(lastError.retryAfterMs, cap);
	}
	return backoffFn(attempt);
}
