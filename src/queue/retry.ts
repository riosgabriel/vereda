import { buildBackoffFn } from "../core/backoff.js"
import { CancelledError, MaxRetriesExceededError, TimeoutError } from "../core/errors.js"
import type { AppError } from "../core/errors.js"
import type { RequestOptions, RetryConfig } from "../core/types.js"
import type { Ticket } from "../ticket/ticket.js"
import type { TicketController } from "../ticket/ticket.js"
import { executeRequest, type MiddlewareFn } from "./executor.js"

export interface RetryJobOptions {
  url: string
  requestOptions: RequestOptions<unknown>
  retryConfig: RetryConfig
  timeoutConfig: { attemptMs?: number }
  ticket: Ticket<unknown>
  controller: TicketController<unknown>
  middleware: MiddlewareFn[]
  onRetry?: (attempt: number, delayMs: number, error: AppError) => void
}

export async function runRetryLoop(job: RetryJobOptions): Promise<void> {
  const {
    url,
    requestOptions,
    retryConfig,
    timeoutConfig,
    ticket,
    controller,
    middleware,
    onRetry,
  } = job

  const maxRetries = retryConfig.maxRetries ?? 3
  const backoffFn = buildBackoffFn(retryConfig.backoff)

  let lastError: AppError = new TimeoutError(url, timeoutConfig.attemptMs ?? 0)

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    if (ticket.isCancelled) {
      controller.markDone({ success: false, error: new CancelledError() } as never)
      return
    }

    if (attempt > 0) {
      // Consult retryWhen before paying for backoff. The first retry skips
      // this check — the client already vetoed via retryVetoed before queuing.
      if (retryConfig.retryWhen && !retryConfig.retryWhen(lastError, attempt)) {
        controller.markDone({ success: false, error: lastError } as never)
        return
      }
    }

    // All retries (including the first) get backoff. The first retry
    // skips the retryWhen check above — the client already vetted via
    // retryVetoed before queuing.
    const delayMs = backoffFn(attempt)
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
        timeoutConfig,
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
