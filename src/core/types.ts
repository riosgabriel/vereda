import type { AppError } from "./errors.js"

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

export type Result<T> =
  { success: true; data: T; raw: Response } | { success: false; error: AppError }

// ---------------------------------------------------------------------------
// Parse function — schema-agnostic
// ---------------------------------------------------------------------------

export type ParseFn<T> = (data: unknown) => T

// ---------------------------------------------------------------------------
// Backoff
// ---------------------------------------------------------------------------

export type BackoffFn = (attempt: number) => number

export interface BackoffOptions {
  /** Base delay in ms. Default: 200 */
  baseDelayMs?: number
  /** Maximum delay cap in ms. Default: 30_000 */
  maxDelayMs?: number
  /** Whether to add jitter. Default: true */
  jitter?: boolean
}

// ---------------------------------------------------------------------------
// Timeout config
// ---------------------------------------------------------------------------

export interface TimeoutConfig {
  /** Per-attempt timeout in ms. Undefined means no per-attempt timeout. */
  attemptMs?: number
}

// ---------------------------------------------------------------------------
// Default retry-on-status codes (D1)
// ---------------------------------------------------------------------------

export const DEFAULT_RETRY_ON_STATUS = [408, 425, 429, 500, 502, 503, 504] as const

// ---------------------------------------------------------------------------
// Partition / bulkhead config
// ---------------------------------------------------------------------------

export interface PartitionConfig {
  /** Max concurrent in-flight retries for this partition */
  concurrency?: number
  /** Max number of pending items in the queue before rejecting new ones */
  maxQueueSize?: number
  retry?: RetryConfig
  timeout?: TimeoutConfig
}

// ---------------------------------------------------------------------------
// Retry config
// ---------------------------------------------------------------------------

export interface RetryConfig {
  maxRetries?: number
  backoff?: BackoffFn | BackoffOptions
  /** HTTP status codes that trigger retry (e.g. 408, 429, 500, 502, 503, 504).
   *  Default: [408, 425, 429, 500, 502, 503, 504] */
  retryOnStatus?: number[]
  /** Optional predicate to decide whether a failed attempt should be retried.
   *  Called with the error and the zero-based attempt number:
   *  - 0 = the first attempt (called client-side before the retry loop)
   *  - 1, 2, … = retries (called inside the loop, after attempt 0)
   *  Returning `false` surfaces the error immediately without retrying. */
  retryWhen?: (error: AppError, attempt: number) => boolean
}

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

export interface Logger {
  debug(msg: string, meta?: Record<string, unknown>): void
  info(msg: string, meta?: Record<string, unknown>): void
  warn(msg: string, meta?: Record<string, unknown>): void
  error(msg: string, meta?: Record<string, unknown>): void
}

// ---------------------------------------------------------------------------
// Lifecycle events
// ---------------------------------------------------------------------------

export type LifecycleEventMap = {
  request: { ticketId: string; url: string; method: string }
  /** Zero-based retry index (0 = first retry after the initial attempt).
   *  Note: retryWhen's attempt parameter uses a different numbering —
   *  0 = first attempt, 1 = first retry, etc. */
  retry: { ticketId: string; url: string; attempt: number; delayMs: number; error: AppError }
  success: { ticketId: string; url: string; attempt: number }
  failure: { ticketId: string; url: string; error: AppError }
}

// ---------------------------------------------------------------------------
// Request options
// ---------------------------------------------------------------------------

export interface RequestOptions<T = unknown> {
  method?: string
  headers?: Record<string, string>
  body?: BodyInit
  /** Named bulkhead partition. Defaults to hostname. */
  partition?: string
  /** Schema parse function. Use withZod() or custom. */
  parse?: ParseFn<T>
  retry?: RetryConfig
  timeout?: TimeoutConfig
  /** Signal to cancel the request externally */
  signal?: AbortSignal
}

// ---------------------------------------------------------------------------
// Client config
// ---------------------------------------------------------------------------

export interface ClientConfig {
  /** Base URL prepended to all requests */
  baseUrl?: string
  /** Default retry config */
  retry?: RetryConfig
  /** Default timeout config */
  timeout?: TimeoutConfig
  /** Global concurrency across all partitions */
  concurrency?: number
  /** Per-partition overrides */
  partitions?: Record<string, PartitionConfig>
  /** Optional structured logger */
  logger?: Logger
}
