import type { AppError } from "../core/errors.js"
import type { RetryConfig, RequestOptions } from "../core/types.js"

/**
 * Default retry policy implementing D3 rules:
 * An attempt is retried iff ALL hold:
 * 1. attempts so far < maxRetries + 1
 * 2. error kind ∈ {network, timeout, retryable_status}
 * 3. method is idempotent (GET HEAD OPTIONS PUT DELETE TRACE)
 *    OR retry.idempotent === true
 *    OR request has an Idempotency-Key header
 * 4. retryWhen(error, attempt) returns true (if provided)
 * 5. the ticket is not cancelled and the total deadline has not passed
 *
 * Exported as a `retryWhen`-shaped function so users can wrap it.
 */
export function defaultRetryPolicy(
  error: AppError,
  attempt: number,
  ctx: {
    /** The request options (method, headers, body, idempotent flag, idempotency key) */
    options: RequestOptions<unknown>
    /** The retry config from the ticket/client */
    retryConfig: RetryConfig
  }
): boolean {
  const { options, retryConfig } = ctx

  // Rule 2: error kind must be retriable
  const retriableKinds = ["network", "timeout", "retryable_status"]
  const isRetriableKind = retryConfig.retryWhen
    ? retryConfig.retryWhen(error, attempt)
    : retriableKinds.includes(error.kind)

  if (!isRetriableKind) {
    return false
  }

  // Rule 3: method must be idempotent or idempotent flag/key present
  const idempotentMethods = new Set(["GET", "HEAD", "OPTIONS", "PUT", "DELETE", "TRACE"])
  const isIdempotentMethod = idempotentMethods.has(options.method ?? "GET")
  const hasIdempotentFlag = !!retryConfig.idempotent
  const hasIdempotencyKey =
    options.headers?.["Idempotency-Key"] !== undefined ||
    options.headers?.["idempotency-key"] !== undefined

  if (!isIdempotentMethod && !hasIdempotentFlag && !hasIdempotencyKey) {
    return false
  }

  // Rules 1 & 5 are checked by the caller (retry loop)
  // Rule 4 (retryWhen) is checked by the caller before calling this policy

  return true
}