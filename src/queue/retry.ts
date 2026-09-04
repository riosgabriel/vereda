import { buildBackoffFn } from "../core/backoff.js";
import type { AppError } from "../core/errors.js";
import {
	CancelledError,
	DeadlineExceededError,
	MaxRetriesExceededError,
	QueueFullError,
	RetryableStatusError,
	TimeoutError,
} from "../core/errors.js";
import type { BackoffOptions, RequestOptions, RetryConfig, TimeoutConfig } from "../core/types.js";
import type { Ticket, TicketController } from "../ticket/ticket.js";
import type { Bulkhead } from "./bulkhead.js";
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
	/** The error from the first attempt (fired client-side before queuing). */
	firstError: AppError;
	onRetry?: (attempt: number, delayMs: number, error: AppError) => void;
	/** Called on success so the client can emit the success event with the
	 *  response status code and the total attempt count. */
	onSuccess?: (statusCode: number, attempts: number) => void;
	/** Called on failure (exhausted retries or policy veto inside the loop)
	 *  so the client can emit the failure event. */
	onFailure?: (error: AppError, attempts: number) => void;
	/** Called on cancellation (user cancel, deadline, or external signal)
	 *  so the client can emit the cancelled event. */
	onCancelled?: (attempts: number) => void;
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
		firstError,
		onRetry,
		onSuccess,
		onFailure,
		onCancelled,
		onCleanup,
		fetch: customFetch,
	} = job;

	const maxRetries = retryConfig.maxRetries ?? 3;
	const backoffFn = buildBackoffFn(retryConfig.backoff);
	const backoffCap =
		retryConfig.backoff && typeof retryConfig.backoff === "object"
			? ((retryConfig.backoff as BackoffOptions).maxDelayMs ?? 30_000)
			: 30_000;

	let lastError: AppError = firstError;
	let totalAttempts = 1; // first attempt already fired client-side

	for (let attempt = 0; attempt < maxRetries; attempt++) {
		if (ticket.isCancelled) {
			onCleanup?.();
			onCancelled?.(totalAttempts);
			controller.markDone({
				success: false,
				error: new CancelledError(),
			} as never);
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
			onFailure?.(lastError, totalAttempts);
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
			if (!ticket.isCancelled && timeoutConfig.totalMs !== undefined) {
				const error = new DeadlineExceededError(url, timeoutConfig.totalMs);
				onFailure?.(error, totalAttempts);
				controller.markDone({
					success: false,
					error,
				} as never);
			} else {
				onCancelled?.(totalAttempts);
				controller.markDone({
					success: false,
					error: new CancelledError(),
				} as never);
			}
			return;
		}

		if (ticket.isCancelled) {
			onCleanup?.();
			onCancelled?.(totalAttempts);
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
							fetch: customFetch,
						},
						middleware,
					),
				semaphore,
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
				onCleanup?.();
				if (result.result.success) {
					onSuccess?.(result.result.raw.status, totalAttempts);
				}
				controller.markDone(result.result);
				return;
			}

			case "cancelled":
				onCleanup?.();
				if (!ticket.isCancelled && timeoutConfig.totalMs !== undefined) {
					const error = new DeadlineExceededError(url, timeoutConfig.totalMs);
					onFailure?.(error, totalAttempts);
					controller.markDone({
						success: false,
						error,
					} as never);
				} else {
					onCancelled?.(totalAttempts);
					controller.markDone({
						success: false,
						error: new CancelledError(),
					} as never);
				}
				return;

			case "timeout":
				lastError = new TimeoutError(url, timeoutConfig.attemptMs ?? 0);
				break;

			case "error":
				lastError = result.error;
				break;
		}
	}

	if (maxRetries === 0) {
		// Zero retries configured/executed — surface the underlying error raw,
		// never wrapped in MaxRetriesExceededError.
		onCleanup?.();
		onFailure?.(lastError, totalAttempts);
		controller.markDone({ success: false, error: lastError } as never);
		return;
	}

	// All retries exhausted — total attempts = 1 (first) + maxRetries (loop)
	totalAttempts = 1 + maxRetries;
	onCleanup?.();
	const exhaustedError = new MaxRetriesExceededError(totalAttempts, lastError);
	onFailure?.(exhaustedError, totalAttempts);
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
