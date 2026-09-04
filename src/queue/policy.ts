import type { AppError } from "../core/errors.js"

export interface RetryPolicyContext {
  method: string
  headers?: Record<string, string>
  /** value of merged retry.idempotent for this request */
  idempotent?: boolean
}

export type RetryPolicy = (error: AppError, attempt: number, ctx: RetryPolicyContext) => boolean

const RETRIABLE_KINDS: ReadonlySet<AppError["kind"]> = new Set(["network", "timeout", "retryable_status"])

const IDEMPOTENT_METHODS = new Set(["GET", "HEAD", "OPTIONS", "PUT", "DELETE", "TRACE"])

/**
 * The default retry policy (decision D3). An attempt is retried iff all hold:
 * 1. attempts so far < maxRetries + 1 (enforced by the retry loop bounds)
 * 2. error `kind` ∈ {network, timeout, retryable_status}
 * 3. method is idempotent (GET HEAD OPTIONS PUT DELETE TRACE) OR
 *    `ctx.idempotent === true` OR the request has an `Idempotency-Key` header
 * 4. user `retryWhen` (consulted separately via `shouldRetry`) returns true
 * 5. the request is not cancelled / past its deadline (handled elsewhere)
 */
export function defaultRetryPolicy(error: AppError, _attempt: number, ctx: RetryPolicyContext): boolean {
  // Rule 2 — the error kind must be transient.
  if (!RETRIABLE_KINDS.has(error.kind)) return false
  // Rule 3 — the request must be safe to repeat (idempotent by method or opt-in).
  if (IDEMPOTENT_METHODS.has(ctx.method.toUpperCase())) return true
  if (ctx.idempotent) return true
  if (ctx.headers && hasHeader(ctx.headers, "idempotency-key")) return true
  return false
}

/**
 * Combined retry gate used by both call sites so rule ordering lives in one
 * place: the default policy runs first, then the user's `retryWhen` is
 * consulted. `retryWhen` can only veto a retry, never force one.
 */
export function shouldRetry(
  error: AppError,
  attempt: number,
  ctx: RetryPolicyContext,
  retryWhen?: (error: AppError, attempt: number) => boolean,
): boolean {
  if (!defaultRetryPolicy(error, attempt, ctx)) return false
  if (retryWhen && !retryWhen(error, attempt)) return false
  return true
}

/** Case-insensitive lookup on a plain header Record. */
function hasHeader(headers: Record<string, string>, name: string): boolean {
  const lower = name.toLowerCase()
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) return true
  }
  return false
}
