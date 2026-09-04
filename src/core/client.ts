import { EventEmitter } from "node:events"
import { BulkheadRegistry } from "../queue/bulkhead.js"
import { executeRequest, type MiddlewareFn } from "../queue/executor.js"
import { type RetryPolicyContext, shouldRetry } from "../queue/policy.js"
import { runRetryLoop } from "../queue/retry.js"
import { createTicket, type Ticket, type TicketController } from "../ticket/ticket.js"
import type { AppError } from "./errors.js"
import {
  CancelledError,
  ConfigurationError,
  DeadlineExceededError,
  NetworkError,
  QueueFullError,
  TimeoutError,
} from "./errors.js"
import { nanoid } from "./nanoid.js"
import type { ClientConfig, LifecycleEventMap, Logger, RequestOptions, RetryConfig, TimeoutConfig } from "./types.js"
import { validateConfig, validateRequestBody } from "./validate.js"

/** Pairs an in-flight ticket with its cleanup function so that
 *  resources (signal listeners, deadline timers) are released synchronously
 *  during shutdown instead of being left to fire-and-forget handlers. */
interface InflightTicket {
  ticket: Ticket<unknown>
  cleanup: () => void
}

export class HttpClient {
  private readonly config: ClientConfig
  private readonly emitter = new EventEmitter()
  private readonly middlewares: MiddlewareFn[] = []
  private readonly bulkheads: BulkheadRegistry
  private readonly logger: Logger | undefined
  private _closed = false
  private readonly _inflightTickets = new Set<InflightTicket>()

  private constructor(config: ClientConfig) {
    this.config = config
    this.logger = config.logger
    this.bulkheads = new BulkheadRegistry({ concurrency: config.concurrency ?? 10 }, config.partitions ?? {})
  }

  static create(config: ClientConfig = {}): HttpClient {
    validateConfig(config)
    return new HttpClient(config)
  }

  // ---------------------------------------------------------------------------
  // Middleware
  // ---------------------------------------------------------------------------

  use(middleware: MiddlewareFn): this {
    this.middlewares.push(middleware)
    return this
  }

  // ---------------------------------------------------------------------------
  // Lifecycle events
  // ---------------------------------------------------------------------------

  on<K extends keyof LifecycleEventMap>(event: K, listener: (data: LifecycleEventMap[K]) => void): this {
    this.emitter.on(event, listener)
    return this
  }

  off<K extends keyof LifecycleEventMap>(event: K, listener: (data: LifecycleEventMap[K]) => void): this {
    this.emitter.off(event, listener)
    return this
  }

  // ---------------------------------------------------------------------------
  // Core request method
  // ---------------------------------------------------------------------------

  request<T>(url: string, options: RequestOptions<T> = {}): Ticket<T> {
    if (this._closed) {
      throw new ConfigurationError("client closed")
    }

    const ticketId = nanoid()
    const { ticket, controller } = createTicket<T>(ticketId)

    // Wire external cancellation: aborting options.signal cancels the ticket.
    // The listener is removed when the ticket reaches a terminal state to
    // prevent a leak on the caller's signal (#7).
    let externalAbortListener: (() => void) | undefined
    if (options.signal) {
      if (options.signal.aborted) {
        ticket.cancel()
      } else {
        externalAbortListener = () => ticket.cancel()
        options.signal.addEventListener("abort", externalAbortListener, { once: true })
      }
    }

    const cleanupExternalSignal = () => {
      if (externalAbortListener && options.signal) {
        options.signal.removeEventListener("abort", externalAbortListener)
        externalAbortListener = undefined
      }
    }

    // Total deadline: a single unref'd timer that aborts the ticket signal
    // on expiry, cancelling in-flight attempts and breaking sleep (#R3).
    const timeoutConfig = this.mergeTimeout(options)
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined
    const cleanupDeadline = () => {
      if (deadlineTimer !== undefined) {
        clearTimeout(deadlineTimer)
        deadlineTimer = undefined
      }
    }
    if (timeoutConfig.totalMs !== undefined) {
      deadlineTimer = setTimeout(() => {
        controller.abortSignal()
      }, timeoutConfig.totalMs)
      deadlineTimer.unref()
    }

    // Track this ticket for graceful shutdown. Store the entry so cleanup
    // can remove the same reference (Set.delete uses reference equality).
    const entry: InflightTicket = { ticket: ticket as Ticket<unknown>, cleanup: () => {} }

    // Combined cleanup: external signal + deadline timer + inflight tracking
    entry.cleanup = () => {
      cleanupExternalSignal()
      cleanupDeadline()
      this._inflightTickets.delete(entry)
    }

    this._inflightTickets.add(entry)

    // Fire and forget — first attempt runs immediately; queued if slow/failed
    this._fireFirstAttempt(
      url,
      options as RequestOptions<unknown>,
      ticket as Ticket<unknown>,
      controller as TicketController<unknown>,
      entry.cleanup,
    ).catch((err: unknown) => {
      // Catch any unexpected throws and surface them as ticket failures
      const error = new NetworkError(err instanceof Error ? err.message : "Unexpected error", {
        cause: err,
      })
      if (ticket.status.state !== "done" && !ticket.isCancelled) {
        controller.markDone({ success: false, error } as never)
      }
      entry.cleanup()
    })

    return ticket
  }

  private async _fireFirstAttempt(
    url: string,
    options: RequestOptions<unknown>,
    ticket: Ticket<unknown>,
    controller: TicketController<unknown>,
    cleanup: () => void,
  ): Promise<void> {
    // Resolve URL and partition inside the async path so relative URLs
    // without a baseUrl surface as ticket errors instead of throwing.
    let fullUrl: string
    let partitionName: string
    try {
      fullUrl = this.resolveUrl(url)
      partitionName = options.partition ?? new URL(fullUrl).hostname
    } catch (err) {
      const error = new NetworkError(err instanceof Error ? err.message : "Invalid URL", {
        cause: err,
      })
      this.emit("failure", { ticketId: ticket.id, url, error })
      controller.markDone({ success: false, error } as never)
      cleanup()
      return
    }

    // Validate the body early in the async path so an unusable body (a raw
    // ReadableStream) surfaces as a ticket ConfigurationError, not a throw.
    try {
      validateRequestBody(options.body)
    } catch (err) {
      const error = err as ConfigurationError
      this.emit("failure", { ticketId: ticket.id, url, error })
      controller.markDone({ success: false, error } as never)
      cleanup()
      return
    }

    const timeoutConfig = this.mergeTimeout(options)
    const retryConfig = this.mergeRetry(options)
    const bulkhead = this.bulkheads.get(partitionName)

    this.emit("request", { ticketId: ticket.id, url: fullUrl, method: options.method ?? "GET" })
    this.logger?.info("Request initiated", {
      ticketId: ticket.id,
      url: fullUrl,
      method: options.method ?? "GET",
      partition: partitionName,
    })
    const result = await executeRequest(
      { url: fullUrl, options, timeoutConfig, retryConfig, signal: ticket.signal },
      this.middlewares,
    )

    switch (result.kind) {
      case "success":
        this.emit("success", { ticketId: ticket.id, url, attempt: 1 })
        this.logger?.info("Request succeeded", { ticketId: ticket.id, url })
        controller.markDone(result.result)
        cleanup()
        return

      case "cancelled":
        if (!ticket.isCancelled && timeoutConfig.totalMs !== undefined) {
          controller.markDone({
            success: false,
            error: new DeadlineExceededError(url, timeoutConfig.totalMs),
          } as never)
        } else {
          controller.markDone({ success: false, error: new CancelledError() } as never)
        }
        cleanup()
        return

      case "error":
        // Apply the unified retry gate (default policy + retryWhen). Errors
        // that fail it (e.g. ValidationError, HttpError) resolve immediately.
        if (this.vetoed(retryConfig, result.error, 0, options, ticket, controller, url)) {
          cleanup()
          return
        }
        // maxRetries=0: no retries configured, surface the raw error immediately
        // without entering the bulkhead (which would waste a slot for no work).
        {
          const effectiveMaxRetries = retryConfig.maxRetries ?? 3
          if (effectiveMaxRetries === 0) {
            this.emit("failure", { ticketId: ticket.id, url, error: result.error })
            controller.markDone({ success: false, error: result.error } as never)
            cleanup()
            return
          }
        }
        controller.markQueued()
        this._scheduleInBulkhead(
          ticket,
          controller,
          url,
          options,
          timeoutConfig,
          retryConfig,
          partitionName,
          bulkhead,
          result.error,
          cleanup,
        )
        return

      case "timeout": {
        const error = new TimeoutError(url, timeoutConfig.attemptMs ?? 0)
        if (this.vetoed(retryConfig, error, 0, options, ticket, controller, url)) {
          cleanup()
          return
        }
        // maxRetries=0: surface timeout immediately without entering the bulkhead
        {
          const effectiveMaxRetries = retryConfig.maxRetries ?? 3
          if (effectiveMaxRetries === 0) {
            this.emit("failure", { ticketId: ticket.id, url, error })
            controller.markDone({ success: false, error } as never)
            cleanup()
            return
          }
        }
        controller.markQueued()
        this._scheduleInBulkhead(
          ticket,
          controller,
          url,
          options,
          timeoutConfig,
          retryConfig,
          partitionName,
          bulkhead,
          error,
          cleanup,
        )
        return
      }
    }
  }

  /** Apply the unified retry gate after the first attempt failed (attempt 0).
   *  Returns true if the request must NOT be retried — the ticket is resolved
   *  with the raw error and must not be queued. */
  private vetoed(
    retryConfig: RetryConfig,
    error: AppError,
    attempt: number,
    options: RequestOptions<unknown>,
    ticket: Ticket<unknown>,
    controller: TicketController<unknown>,
    url: string,
  ): boolean {
    const ctx: RetryPolicyContext = {
      method: options.method ?? "GET",
      headers: options.headers,
      idempotent: retryConfig.idempotent,
    }
    if (!shouldRetry(error, attempt, ctx, retryConfig.retryWhen)) {
      this.emit("failure", { ticketId: ticket.id, url, error })
      controller.markDone({ success: false, error } as never)
      return true
    }
    return false
  }

  private _scheduleInBulkhead(
    ticket: Ticket<unknown>,
    controller: TicketController<unknown>,
    url: string,
    options: RequestOptions<unknown>,
    timeoutConfig: TimeoutConfig,
    retryConfig: RetryConfig,
    partitionName: string,
    bulkhead: ReturnType<BulkheadRegistry["get"]>,
    firstError: AppError,
    cleanup: () => void,
  ): void {
    this.logger?.info("Request queued for retry", {
      ticketId: ticket.id,
      url,
      partition: partitionName,
    })

    bulkhead
      .schedule(async () => {
        await runRetryLoop({
          url,
          requestOptions: options,
          timeoutConfig,
          retryConfig,
          ticket,
          controller,
          middleware: this.middlewares,
          firstError,
          onRetry: (attempt, delayMs, error) => {
            this.emit("retry", { ticketId: ticket.id, url, attempt, delayMs, error })
          },
          onCleanup: cleanup,
        })

        const status = ticket.status
        if (status.state === "done") {
          if (status.result.success) {
            this.emit("success", { ticketId: ticket.id, url, attempt: -1 })
          } else {
            this.emit("failure", { ticketId: ticket.id, url, error: status.result.error })
            this.logger?.warn("Request failed after retries", {
              ticketId: ticket.id,
              url,
              error: status.result.error.message,
            })
          }
        }
      })
      .catch((err: unknown) => {
        if (err instanceof QueueFullError) {
          this.emit("failure", { ticketId: ticket.id, url, error: err })
          controller.markDone({ success: false, error: err } as never)
          cleanup()
          return
        }
        const error = new NetworkError(err instanceof Error ? err.message : "Queue error", {
          cause: err,
        })
        this.emit("failure", { ticketId: ticket.id, url, error })
        controller.markDone({ success: false, error } as never)
        cleanup()
      })
  }

  // ---------------------------------------------------------------------------
  // Convenience methods
  // ---------------------------------------------------------------------------

  get<T>(url: string, options: Omit<RequestOptions<T>, "method"> = {}): Ticket<T> {
    return this.request<T>(url, { ...options, method: "GET" })
  }

  post<T>(
    url: string,
    body?: BodyInit | (() => BodyInit),
    options: Omit<RequestOptions<T>, "method" | "body"> = {},
  ): Ticket<T> {
    return this.request<T>(url, { ...options, method: "POST", body })
  }

  put<T>(
    url: string,
    body?: BodyInit | (() => BodyInit),
    options: Omit<RequestOptions<T>, "method" | "body"> = {},
  ): Ticket<T> {
    return this.request<T>(url, { ...options, method: "PUT", body })
  }

  patch<T>(
    url: string,
    body?: BodyInit | (() => BodyInit),
    options: Omit<RequestOptions<T>, "method" | "body"> = {},
  ): Ticket<T> {
    return this.request<T>(url, { ...options, method: "PATCH", body })
  }

  delete<T>(url: string, options: Omit<RequestOptions<T>, "method"> = {}): Ticket<T> {
    return this.request<T>(url, { ...options, method: "DELETE" })
  }

  // ---------------------------------------------------------------------------
  // Graceful shutdown
  // ---------------------------------------------------------------------------

  /** Close the client. New requests throw `ConfigurationError("client closed")`.
   *  When `drain` is true, in-flight tickets are awaited up to `timeoutMs`
   *  before the promise resolves, then remaining tickets are cancelled.
   *  When `drain` is false (default), all in-flight tickets are cancelled
   *  immediately.
   *
   *  `timeoutMs` is required when `drain` is true to prevent indefinite
   *  hangs — use a value that fits your shutdown budget. */
  async close(opts?: { drain?: boolean; timeoutMs: number }): Promise<void> {
    if (this._closed) return // idempotent
    this._closed = true

    if (opts?.drain && (!opts.timeoutMs || opts.timeoutMs <= 0)) {
      throw new ConfigurationError("close({ drain: true }) requires a positive timeoutMs")
    }
    const { drain = false, timeoutMs = 0 } = opts ?? {}
    const entries = [...this._inflightTickets]

    if (!drain || entries.length === 0) {
      // Cancel all in-flight immediately
      for (const entry of entries) {
        entry.cleanup()
        entry.ticket.cancel()
      }
      this._inflightTickets.clear()
      return
    }

    // Drain: wait for all to resolve, up to timeoutMs
    const done = Promise.all(entries.map((e) => e.ticket.toPromise()))
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs)
      timer.unref()
    })
    await Promise.race([done, timeout])
    // Cancel any remaining in-flight tickets and cleanup
    for (const entry of this._inflightTickets) {
      entry.cleanup()
      entry.ticket.cancel()
    }
    // Clear the timeout timer if tickets resolved first
    if (timer !== undefined) {
      clearTimeout(timer)
    }

    this._inflightTickets.clear()
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private resolveUrl(url: string): string {
    if (this.config.baseUrl) {
      return new URL(url, this.config.baseUrl).toString()
    }
    return url
  }

  private mergeTimeout(options: RequestOptions<unknown>): TimeoutConfig {
    return { ...this.config.timeout, ...options.timeout }
  }

  private mergeRetry(options: RequestOptions<unknown>): RetryConfig {
    return { ...this.config.retry, ...options.retry }
  }

  private emit<K extends keyof LifecycleEventMap>(event: K, data: LifecycleEventMap[K]): void {
    this.emitter.emit(event, data)
  }
}
