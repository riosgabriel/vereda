import { buildBackoffFn } from "../core/backoff.js"
import { CancelledError, MaxRetriesExceededError, TimeoutError } from "../core/errors.js"
import type { AppError } from "../core/errors.js"
import type { RequestOptions, RetryConfig } from "../core/types.js"
import { defaultRetryPolicy } from "../queue/policy.js"
import type { Ticket } from "../ticket/ticket.js"
import type { TicketController } from "../ticket/ticket.js"
import { executeRequest, type MiddlewareFn } from "./executor.js"

export interface RetryJobOptions {
  url: string
  requestOptions: RequestOptions<unknown>
  timeoutMs?: number
  retryConfig: RetryConfig
  ticket: Ticket<unknown>
  controller: TicketController<unknown>
  middleware: MiddlewareFn[]
  onRetry?: (attempt: number, delayMs: number, error: AppError) => void
}

function computeDelayMs(
  attempt: number,
  backoffFn: (attempt: number) => number,
  retryAfterMs?: number,
  maxDelayMs?: number,
): number {
  // If Retry-After header was provided, use it (capped at maxDelayMs)
  if (retryAfterMs !== undefined) {
    const cap = maxDelayMs ?? Infinity
    return Math.min(retryAfterMs, cap)
  }
  // Otherwise use default backoff
  return backoffFn(attempt)
}

export async function runRetryLoop(job: RetryJobOptions): Promise<void> {
  const {
    url,
    requestOptions,
    timeoutMs,
    retryConfig,
    ticket,
    controller,
    middleware,
    onRetry,
  } = job

  const maxRetries = retryConfig.maxRetries ?? 3
  const backoffFn = buildBackoffFn(retryConfig.backoff)

  let lastError: AppError = new TimeoutError(url, timeoutMs ?? 0)

  // Extract method and headers for idempotency check
  const method = requestOptions.method ?? "GET"
  const headers = requestOptions.headers

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    if (ticket.isCancelled) {
      controller.markDone({ success: false, error: new CancelledError() } as never)
      return
    }

    // Consult defaultRetryPolicy before paying for backoff.
    // Rule 2: error kind must be network, timeout, or retryable_status
    // Rule 3: method must be idempotent or retry.idempotent must be true or Idempotency-Key header present
    const shouldRetry = defaultRetryPolicy(lastError, attempt, {
      method,
      headers,
      retryIdempotent: retryConfig.idempotent,
    })

    if (!shouldRetry) {
      // Surface the error immediately without retrying
      controller.markDone({ success: false, error: lastError } as never)
      return
    }

    if (attempt > 0) {
      // Consult retryWhen after defaultRetryPolicy (rule 4).
      // The first retry (attempt 0) was already vetted via retryVetoed before queuing.
      if (retryConfig.retryWhen && !retryConfig.retryWhen(lastError, attempt)) {
        controller.markDone({ success: false, error: lastError } as never)
        return
      }
    }

    // Compute delay: use Retry-After header if available, otherwise default backoff
    const delayMs = computeDelayMs(
      attempt,
      backoffFn,
      (lastError as { retryAfterMs?: number }).retryAfterMs,
      retryConfig.maxDelayMs,
    )
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
        retryConfig,
        timeoutMs,
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
        lastError = new TimeoutError(url, timeoutMs ?? 0)
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
