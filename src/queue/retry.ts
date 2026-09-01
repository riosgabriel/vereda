import { buildBackoffFn } from "../core/backoff.js"
import {
  CancelledError,
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
      controller.markDone({ success: false, error: new CancelledError() } as never)
      return
    }

    if (attempt > 0) {
      // Consult the default policy + retryWhen before paying for backoff.
      // The first retry skips this check — the client already vetted the
      // error via the same gate before queuing.
      const ctx: RetryPolicyContext = {
        method: requestOptions.method ?? "GET",
        headers: requestOptions.headers,
        idempotent: retryConfig.idempotent,
      }
      if (!shouldRetry(lastError, attempt, ctx, retryConfig.retryWhen)) {
        controller.markDone({ success: false, error: lastError } as never)
        return
      }
    }

    // All retries (including the first) get backoff. The first retry
    // skips the gate above — the client already vetted before queuing.
    const delayMs = resolveRetryDelay(lastError, backoffFn, attempt, backoffCap)
    onRetry?.(attempt, delayMs, lastError)
    controller.markRetrying(attempt, delayMs)
    await sleep(delayMs)

    if (ticket.isCancelled) {
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
        controller.markDone(result.result)
        return

      case "cancelled":
        controller.markDone({ success: false, error: new CancelledError() } as never)
        return

      case "timeout":
        lastError = new TimeoutError(url, timeoutConfig.attemptMs ?? 0)
        break

      case "error":
        lastError = result.error
        break
    }
  }

  // All retries exhausted — total attempts = 1 (first) + maxRetries (loop)
  const totalAttempts = maxRetries + 1
  controller.markDone({
    success: false,
    error: new MaxRetriesExceededError(totalAttempts, lastError),
  } as never)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
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
