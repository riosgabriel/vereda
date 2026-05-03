import { buildBackoffFn } from "../core/backoff.js";
import {
  CancelledError,
  MaxRetriesExceededError,
  TimeoutError,
} from "../core/errors.js";
import type { AppError } from "../core/errors.js";
import type { RequestOptions, RetryConfig, TriggerConfig } from "../core/types.js";
import type { Ticket } from "../ticket/ticket.js";
import { executeRequest, type MiddlewareFn } from "./executor.js";

export interface RetryJobOptions {
  url: string;
  requestOptions: RequestOptions<unknown>;
  triggerConfig: TriggerConfig;
  retryConfig: RetryConfig;
  ticket: Ticket<unknown>;
  middleware: MiddlewareFn[];
}

export async function runRetryLoop(job: RetryJobOptions): Promise<void> {
  const {
    url,
    requestOptions,
    triggerConfig,
    retryConfig,
    ticket,
    middleware,
  } = job;

  const maxAttempts = retryConfig.maxAttempts ?? 3;
  const backoffFn = buildBackoffFn(retryConfig.backoff);

  let lastError: AppError = new TimeoutError(url, triggerConfig.timeoutMs ?? 0);

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (ticket.isCancelled) {
      ticket._markDone({ success: false, error: new CancelledError() });
      return;
    }

    if (attempt > 0) {
      const delayMs = backoffFn(attempt - 1);
      ticket._markRetrying(attempt, delayMs);
      await sleep(delayMs);
    }

    if (ticket.isCancelled) {
      ticket._markDone({ success: false, error: new CancelledError() });
      return;
    }

    const result = await executeRequest(
      {
        url,
        options: requestOptions,
        triggerConfig,
        signal: ticket.signal,
      },
      middleware
    );

    switch (result.kind) {
      case "success":
        ticket._markDone(result.result);
        return;

      case "cancelled":
        ticket._markDone({ success: false, error: new CancelledError() });
        return;

      case "timeout":
        lastError = new TimeoutError(url, triggerConfig.timeoutMs ?? 0);
        // Continue to next attempt
        break;

      case "queued_status":
        lastError = new TimeoutError(
          url,
          triggerConfig.timeoutMs ?? 0
        );
        // Continue to next attempt
        break;

      case "error":
        lastError = result.error;
        // Continue to next attempt
        break;
    }
  }

  // All attempts exhausted
  ticket._markDone({
    success: false,
    error: new MaxRetriesExceededError(maxAttempts, lastError),
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
