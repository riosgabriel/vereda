import { buildBackoffFn } from "../core/backoff.js"
import {
  CancelledError,
  DeadlineExceededError,
  MaxRetriesExceededError,
  RetryableStatusError,
  TimeoutError,
} from "../core/errors.js"
import type { AppError } from "../core/errors.js"
import type { BackoffOptions, RequestOptions, RetryConfig, TimeoutConfig } from "../core/types.js"
import type { Ticket } from "../ticket/ticket.js"
import type { TicketController } from "../ticket/ticket.js"
import { executeRequest, type MiddlewareFn } from "./executor.js"
import { shouldRetry, type RetryPolicyContext } from "./policy.js"

export interface RetryJobOptions {
  url: string
  requestOptions: RequestOptions<unknown>
  timeoutConfig: TimeoutConfig
  retryConfig: RetryConfig
  ticket: Ticket<unknown>
  controller: TicketController<unknown>
  middleware: MiddlewareFn[]
  /** The error from the first attempt (fired client-side before queuing). */
  firstError: AppError
  onRetry?: (attempt: number, delayMs: number, error: AppError) => void
  /** Called before markDone to clean up external resources (e.g. signal listeners). */
  onCleanup?: () => void
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
    firstError,
    onRetry,
    onCleanup,
  } = job

  const maxRetries = retryConfig.maxRetries ?? 3
  const backoffFn = buildBackoffFn(retryConfig.backoff)
  const backoffCap =
    retryConfig.backoff && typeof retryConfig.backoff === "object"
      ? ((retryConfig.backoff as BackoffOptions).maxDelayMs ?? 30_000)
      : 30_000

  let lastError: AppError = firstError

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    if (ticket.isCancelled) {
      onCleanup?.()
      controller.markDone({ success: false, error: new CancelledError() } as never)
      return
    }

    // Consult the default policy + retryWhen for every retry iteration.
    // The first attempt was already vetted at queue time (before the bulkhead),
    // but each retry within the bulkhead must pass the same gate so that
    // a user-provided retryWhen correctly limits retries to N+1 attempts total.
    const ctx: RetryPolicyContext = {
      method: requestOptions.method ?? "GET",
      headers: requestOptions.headers,
      idempotent: retryConfig.idempotent,
    }
    if (!shouldRetry(lastError, attempt, ctx, retryConfig.retryWhen)) {
      onCleanup?.()
      controller.markDone({ success: false, error: lastError } as never)
      return
    }

    // All retries get backoff. Every retry is gated by the policy check above.
    const delayMs = resolveRetryDelay(lastError, backoffFn, attempt, backoffCap)
    onRetry?.(attempt, delayMs, lastError)
    controller.markRetrying(attempt, delayMs)

    try {
      await sleep(delayMs, ticket.signal)
    } catch {
      // The deadline timer aborts the ticket signal. Distinguish deadline from
      // user cancellation: deadline only aborts the signal (abortSignal()),
      // while user cancellation sets _cancelled = true via cancel().
      onCleanup?.()
      if (!ticket.isCancelled && timeoutConfig.totalMs !== undefined) {
        controller.markDone({
          success: false,
          error: new DeadlineExceededError(url, timeoutConfig.totalMs),
        } as never)
      } else {
        controller.markDone({ success: false, error: new CancelledError() } as never)
      }
      return
    }

    if (ticket.isCancelled) {
      onCleanup?.()
      controller.markDone({ success: false, error: new CancelledError() } as never)
      return
    }

    const result = await executeRequest(
      {
        url,
        options: requestOptions,
        timeoutConfig,
        retryConfig,
        signal: ticket.signal,
      },
      middleware,
    )

    switch (result.kind) {
      case "success":
        onCleanup?.()
        controller.markDone(result.result)
        return

      case "cancelled":
        onCleanup?.()
        if (!ticket.isCancelled && timeoutConfig.totalMs !== undefined) {
          controller.markDone({
            success: false,
            error: new DeadlineExceededError(url, timeoutConfig.totalMs),
          } as never)
        } else {
          controller.markDone({ success: false, error: new CancelledError() } as never)
        }
        return

      case "timeout":
        lastError = new TimeoutError(url, timeoutConfig.attemptMs ?? 0)
        break

      case "error":
        lastError = result.error
        break
    }
  }

  if (maxRetries === 0) {
    // Zero retries configured/executed — surface the underlying error raw,
    // never wrapped in MaxRetriesExceededError.
    onCleanup?.()
    controller.markDone({ success: false, error: lastError } as never)
    return
  }

  // All retries exhausted — total attempts = 1 (first) + maxRetries (loop)
  const totalAttempts = maxRetries + 1
  onCleanup?.()
  controller.markDone({
    success: false,
    error: new MaxRetriesExceededError(totalAttempts, lastError),
  } as never)
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException("The operation was aborted", "AbortError"))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal!.reason ?? new DOMException("The operation was aborted", "AbortError"))
    }
    signal?.addEventListener("abort", onAbort, { once: true })
  })
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
    return Math.min(lastError.retryAfterMs, cap)
  }
  return backoffFn(attempt)
}
