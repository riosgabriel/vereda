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
// Trigger conditions
// ---------------------------------------------------------------------------

export interface TriggerConfig {
  /** Hard timeout in ms before the request is cancelled and queued */
  timeoutMs?: number
  /** HTTP status codes that trigger queuing (e.g. 429, 503) */
  queueOnStatus?: number[]
}

// ---------------------------------------------------------------------------
// Partition / bulkhead config
// ---------------------------------------------------------------------------

export interface PartitionConfig {
  /** Max concurrent in-flight retries for this partition */
  concurrency?: number
  /** Max number of pending items in the queue before rejecting new ones */
  maxQueueSize?: number
  trigger?: TriggerConfig
  retry?: RetryConfig
}

// ---------------------------------------------------------------------------
// Retry config
// ---------------------------------------------------------------------------

export interface RetryConfig {
  maxAttempts?: number
  backoff?: BackoffFn | BackoffOptions
  /** Optional predicate to decide whether a failed attempt should be retried.
   *  Called with the error from the most recent failed attempt and that
   *  attempt's zero-based number (0 = the first attempt). Consulted after
   *  every failed attempt — including the first, before any retry is
   *  scheduled — so returning `false` surfaces the error immediately. */
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
  trigger?: TriggerConfig
  retry?: RetryConfig
  /** Signal to cancel the request externally */
  signal?: AbortSignal
}

// ---------------------------------------------------------------------------
// Client config
// ---------------------------------------------------------------------------

export interface ClientConfig {
  /** Base URL prepended to all requests */
  baseUrl?: string
  /** Default trigger config */
  trigger?: TriggerConfig
  /** Default retry config */
  retry?: RetryConfig
  /** Global concurrency across all partitions */
  concurrency?: number
  /** Per-partition overrides */
  partitions?: Record<string, PartitionConfig>
  /** Optional structured logger */
  logger?: Logger
}
