import type { AppError } from "../core/errors.js"
import type { RetryConfig } from "../core/types.js"

/**
 * Default retry policy implementing D3 rules 2–3.
 *
 * An attempt is retried iff:
 * 1. Error kind ∈ { network, timeout, retryable_status }
 * 2. Method is idempotent (GET HEAD OPTIONS PUT DELETE TRACE)
 *    OR retry.idempotent === true
 *    OR request has an Idempotency-Key header
 * 3. retryWhen (if provided) is consulted after this policy (rule 4)
 *
 * @param error - The error from the failed attempt
 * @param attempt - Zero-based attempt number (0 = first attempt, 1+ = retries)
 * @param ctx - Context containing method, headers, and retry config
 * @returns true if the attempt should be retried
 */
export function defaultRetryPolicy(
  error: AppError,
  attempt: number,
  ctx: {
    method?: string
    headers?: Record<string, string>
    retryIdempotent?: boolean
  } = {},
): boolean {
  // Rule 2: error kind must be retryable (network, timeout, retryable_status)
  const retryableKinds = ["network", "timeout", "retryable_status"]
  const isRetryableKind = retryableKinds.includes(error.kind)

  if (!isRetryableKind) {
    return false
  }

  // Rule 3: method must be idempotent, or retry.idempotent must be true,
  // or the request must have an Idempotency-Key header
  const idempotentMethods = new Set(["GET", "HEAD", "OPTIONS", "PUT", "DELETE", "TRACE"])
  const method = ctx.method ?? "GET"
  const isIdempotentMethod = idempotentMethods.has(method)
  const hasIdempotencyKey = ctx.headers?.["Idempotency-Key"] !== undefined
  const retryIdempotent = ctx.retryIdempotent

  return isIdempotentMethod || retryIdempotent === true || hasIdempotencyKey
}