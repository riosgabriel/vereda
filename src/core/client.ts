import { EventEmitter } from "node:events"
import type {
  ClientConfig,
  LifecycleEventMap,
  Logger,
  PartitionConfig,
  RequestOptions,
  RetryConfig,
  TimeoutConfig,
} from "./types.js"
import type { AppError } from "./errors.js"
import {
  NetworkError,
  CancelledError,
  DeadlineExceededError,
  TimeoutError,
  QueueFullError,
  ConfigurationError,
} from "./errors.js"
import { BulkheadRegistry, type BulkheadSnapshot } from "../queue/bulkhead.js"
import { Semaphore } from "../queue/semaphore.js"
import { executeRequest, type MiddlewareFn } from "../queue/executor.js"
import { shouldRetry, type RetryPolicyContext } from "../queue/policy.js"
import { runRetryLoop } from "../queue/retry.js"
import { Ticket, createTicket, type TicketController } from "../ticket/ticket.js"
import { nanoid } from "./nanoid.js"
import { METRICS, type MetricsSink } from "./metrics.js"
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
  private readonly partitionConfigs: Record<string, PartitionConfig>
  private readonly logger: Logger | undefined
  private readonly metrics: MetricsSink | undefined
  private _closed = false
  private readonly _inflightTickets = new Set<InflightTicket>()

  private constructor(config: ClientConfig) {
    this.config = config
    this.logger = config.logger
    this.metrics = config.metrics
    this.partitionConfigs = config.partitions ?? {}
    const semaphore = new Semaphore(config.concurrency ?? 50)
    this.bulkheads = new BulkheadRegistry({}, this.partitionConfigs, 60_000, semaphore)
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

  on<K extends keyof LifecycleEventMap>(
    event: K,
    listener: (data: LifecycleEventMap[K]) => void,
  ): this {
    this.emitter.on(event, listener)
    return this
  }

  off<K extends keyof LifecycleEventMap>(
    event: K,
    listener: (data: LifecycleEventMap[K]) => void,
  ): this {
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

    const startTime = Date.now()
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
    // Use the explicit partition if available for the merge; the resolved
    // partition (hostname) will be used for retries in _fireFirstAttempt.
    const timeoutConfig = this.mergeTimeout(options, options.partition)
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
      startTime,
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
    startTime: number,
  ): Promise<void> {
    // Resolve URL and partition inside the async path so relative URLs
    // without a baseUrl surface as ticket errors instead of throwing.
    let fullUrl: string
    let partitionName: string
    try {
      fullUrl = this.resolveUrl(url)
      partitionName = options.partition ?? new URL(fullUrl).host
    } catch (err) {
      const error = new NetworkError(err instanceof Error ? err.message : "Invalid URL", {
        cause: err,
      })
      const durationMs = Date.now() - startTime
      this.emit("failure", {
        ticketId: ticket.id,
        url,
        attempts: 1,
        durationMs,
        queuedMs: 0,
        error,
      })
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
      const durationMs = Date.now() - startTime
      this.emit("failure", {
        ticketId: ticket.id,
        url,
        attempts: 1,
        durationMs,
        queuedMs: 0,
        error,
      })
      controller.markDone({ success: false, error } as never)
      cleanup()
      return
    }

    const timeoutConfig = this.mergeTimeout(options, partitionName)
    const retryConfig = this.mergeRetry(options, partitionName)
    const bulkhead = this.bulkheads.get(partitionName)

    this.emit("request", {
      ticketId: ticket.id,
      url: fullUrl,
      method: options.method ?? "GET",
      partition: partitionName,
    })
    this.logger?.info("Request initiated", {
      ticketId: ticket.id,
      url: fullUrl,
      method: options.method ?? "GET",
      partition: partitionName,
    })

    // The global semaphore limits total concurrent executions across all
    // partitions. It is acquired for every attempt (including the first),
    // while the per-partition bulkhead slot only applies to retries (D4).
    const semaphore = this.bulkheads.getSemaphore()
    const execute = () =>
      executeRequest(
        { url: fullUrl, options, timeoutConfig, retryConfig, signal: ticket.signal },
        this.middlewares,
      )

    // When partition.limitFirstAttempts is enabled (R6), the first attempt
    // also goes through the per-partition bulkhead. Otherwise it bypasses
    // the partition slot entirely (D4). The global semaphore is always
    // acquired for every attempt.
    const usePartitionBulkhead = bulkhead.limitFirstAttempts
    const result = usePartitionBulkhead
      ? await bulkhead.run(
          () => (semaphore ? semaphore.acquire().then((r) => execute().finally(r)) : execute()),
          semaphore,
        )
      : semaphore
        ? await semaphore.acquire().then((release) => execute().finally(release))
        : await execute()

    switch (result.kind) {
      case "success": {
        const durationMs = Date.now() - startTime
        const statusCode = result.result.success ? result.result.raw.status : 0
        this.emit("success", {
          ticketId: ticket.id,
          url,
          attempts: 1,
          durationMs,
          queuedMs: 0,
          statusCode,
        })
        this.logger?.info("Request succeeded", { ticketId: ticket.id, url })
        controller.markDone(result.result)
        cleanup()
        return
      }

      case "cancelled": {
        const durationMs = Date.now() - startTime
        this.emit("cancelled", { ticketId: ticket.id, url, attempts: 1, durationMs })
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
      }

      case "error":
        // Apply the unified retry gate (default policy + retryWhen). Errors
        // that fail it (e.g. ValidationError, HttpError) resolve immediately.
        if (
          this.vetoed(retryConfig, result.error, 0, options, ticket, controller, url, startTime)
        ) {
          cleanup()
          return
        }
        // maxRetries=0: no retries configured, surface the raw error immediately
        // without entering the bulkhead (which would waste a slot for no work).
        {
          const effectiveMaxRetries = retryConfig.maxRetries ?? 3
          if (effectiveMaxRetries === 0) {
            const durationMs = Date.now() - startTime
            this.emit("failure", {
              ticketId: ticket.id,
              url,
              attempts: 1,
              durationMs,
              queuedMs: 0,
              error: result.error,
            })
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
          startTime,
        )
        return

      case "timeout": {
        const error = new TimeoutError(url, timeoutConfig.attemptMs ?? 0)
        if (this.vetoed(retryConfig, error, 0, options, ticket, controller, url, startTime)) {
          cleanup()
          return
        }
        // maxRetries=0: surface timeout immediately without entering the bulkhead
        {
          const effectiveMaxRetries = retryConfig.maxRetries ?? 3
          if (effectiveMaxRetries === 0) {
            const durationMs = Date.now() - startTime
            this.emit("failure", {
              ticketId: ticket.id,
              url,
              attempts: 1,
              durationMs,
              queuedMs: 0,
              error,
            })
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
          startTime,
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
    startTime: number,
  ): boolean {
    const ctx: RetryPolicyContext = {
      method: options.method ?? "GET",
      headers: options.headers,
      idempotent: retryConfig.idempotent,
    }
    if (!shouldRetry(error, attempt, ctx, retryConfig.retryWhen)) {
      const durationMs = Date.now() - startTime
      this.emit("failure", {
        ticketId: ticket.id,
        url,
        attempts: 1,
        durationMs,
        queuedMs: 0,
        error,
      })
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
    startTime: number,
  ): void {
    this.logger?.info("Request queued for retry", {
      ticketId: ticket.id,
      url,
      partition: partitionName,
    })

    // Run the retry loop directly — each attempt inside the loop acquires its
    // own bulkhead slot via bulkhead.run() so other tickets are not blocked
    // for the entire retry lifetime (#5, D4). QueueFullError from the loop
    // is caught here and surfaced as a terminal ticket failure.
    runRetryLoop({
      url,
      requestOptions: options,
      timeoutConfig,
      retryConfig,
      ticket,
      controller,
      middleware: this.middlewares,
      bulkhead,
      semaphore: this.bulkheads.getSemaphore(),
      firstError,
      onRetry: (attempt, delayMs, error) => {
        this.emit("retry", { ticketId: ticket.id, url, attempt, delayMs, error })
      },
      onSuccess: (statusCode, attempts) => {
        const durationMs = Date.now() - startTime
        this.emit("success", {
          ticketId: ticket.id,
          url,
          attempts,
          durationMs,
          queuedMs: 0,
          statusCode,
        })
      },
      onFailure: (error, attempts) => {
        const durationMs = Date.now() - startTime
        this.emit("failure", {
          ticketId: ticket.id,
          url,
          attempts,
          durationMs,
          queuedMs: 0,
          error,
        })
        this.logger?.warn("Request failed after retries", {
          ticketId: ticket.id,
          url,
          error: error.message,
        })
      },
      onCancelled: (attempts) => {
        const durationMs = Date.now() - startTime
        this.emit("cancelled", { ticketId: ticket.id, url, attempts, durationMs })
      },
      onCleanup: cleanup,
    })
      .catch((err: unknown) => {
        // QueueFullError is already handled inside runRetryLoop (marks done +
        // re-throws). The client catches it here for emission and cleanup.
        if (err instanceof QueueFullError) {
          const durationMs = Date.now() - startTime
          this.emit("failure", {
            ticketId: ticket.id,
            url,
            attempts: 1,
            durationMs,
            queuedMs: 0,
            error: err,
          })
          // Ticket already marked done inside the loop — skip markDone.
          cleanup()
          return
        }
        const error = new NetworkError(err instanceof Error ? err.message : "Queue error", {
          cause: err,
        })
        this.emit("failure", {
          ticketId: ticket.id,
          url,
          attempts: 1,
          durationMs: Date.now() - startTime,
          queuedMs: 0,
          error,
        })
        if (ticket.status.state !== "done" && !ticket.isCancelled) {
          controller.markDone({ success: false, error } as never)
        }
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
  // Partition snapshots
  // ---------------------------------------------------------------------------

  /** Return a snapshot of all active bulkhead partitions.
   *  Each entry includes the partition name, running/queued counts,
   *  and configured concurrency/maxQueueSize limits. */
  partitions(): BulkheadSnapshot[] {
    return this.bulkheads.getAll()
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

  private mergeTimeout(options: RequestOptions<unknown>, partitionName?: string): TimeoutConfig {
    const partitionConfig = partitionName ? this.partitionConfigs[partitionName] : undefined
    return { ...this.config.timeout, ...partitionConfig?.timeout, ...options.timeout }
  }

  private mergeRetry(options: RequestOptions<unknown>, partitionName?: string): RetryConfig {
    const partitionConfig = partitionName ? this.partitionConfigs[partitionName] : undefined
    return { ...this.config.retry, ...partitionConfig?.retry, ...options.retry }
  }

  private emit<K extends keyof LifecycleEventMap>(event: K, data: LifecycleEventMap[K]): void {
    this.emitter.emit(event, data)

    // Emit metrics if a sink is configured
    if (this.metrics) {
      const e = event as string
      if (e === "request") {
        const d = data as LifecycleEventMap["request"]
        this.metrics.counter(METRICS.REQUESTS, 1, { partition: d.partition, method: d.method })
        this.metrics.gauge(METRICS.IN_FLIGHT, this._inflightTickets.size)
      } else if (e === "retry") {
        const d = data as LifecycleEventMap["retry"]
        this.metrics.counter(METRICS.RETRIES, 1, { kind: d.error.kind })
      } else if (e === "success" || e === "failure" || e === "cancelled") {
        const d = data as
          | LifecycleEventMap["success"]
          | LifecycleEventMap["failure"]
          | LifecycleEventMap["cancelled"]
        const kind =
          e === "success"
            ? "success"
            : e === "failure"
              ? (d as LifecycleEventMap["failure"]).error.kind
              : "cancelled"
        this.metrics.histogram(METRICS.DURATION, d.durationMs, { kind })
        this.metrics.gauge(METRICS.IN_FLIGHT, this._inflightTickets.size)
      }
    }
  }
}
