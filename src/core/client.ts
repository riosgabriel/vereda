import { EventEmitter } from "node:events"
import type {
  ClientConfig,
  Logger,
  RequestOptions,
  RetryConfig,
  TimeoutConfig,
} from "./types.js"
import type { AppError } from "./errors.js"
import {
  NetworkError,
  CancelledError,
  TimeoutError,
  ValidationError,
} from "./errors.js"
import { BulkheadRegistry } from "../queue/bulkhead.js"
import { executeRequest, type MiddlewareFn } from "../queue/executor.js"
import { runRetryLoop } from "../queue/retry.js"
import { Ticket, createTicket, type TicketController } from "../ticket/ticket.js"
import { nanoid } from "./nanoid.js"
import { validateConfig } from "./validate.js"

export class HttpClient {
  private readonly config: ClientConfig
  private readonly emitter = new EventEmitter()
  private readonly middlewares: MiddlewareFn[] = []
  private readonly bulkheads: BulkheadRegistry
  private readonly logger: Logger | undefined

  private constructor(config: ClientConfig) {
    this.config = config
    this.logger = config.logger
    this.bulkheads = new BulkheadRegistry(
      { concurrency: config.concurrency ?? 10 },
      config.partitions ?? {},
    )
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

  on(event: string, listener: (...args: any[]) => void): this {
    this.emitter.on(event, listener)
    return this
  }

  off(event: string, listener: (...args: any[]) => void): this {
    this.emitter.off(event, listener)
    return this
  }

  // ---------------------------------------------------------------------------
  // Core request method
  // ---------------------------------------------------------------------------

  request<T>(url: string, options: RequestOptions<T> = {}): Ticket<T> {
    const ticketId = nanoid()
    const { ticket, controller } = createTicket<T>(ticketId)

    // Wire external cancellation: aborting options.signal cancels the ticket
    if (options.signal) {
      if (options.signal.aborted) {
        ticket.cancel()
      } else {
        options.signal.addEventListener("abort", () => ticket.cancel(), { once: true })
      }
    }

    // Fire and forget — first attempt runs immediately; queued if slow/failed
    this._fireFirstAttempt(
      url,
      options as RequestOptions<unknown>,
      ticket as Ticket<unknown>,
      controller as TicketController<unknown>,
    ).catch((err: unknown) => {
      // Catch any unexpected throws and surface them as ticket failures
      const error = new NetworkError(err instanceof Error ? err.message : "Unexpected error", {
        cause: err,
      })
      if (ticket.status.state !== "done" && !ticket.isCancelled) {
        controller.markDone({ success: false, error } as never)
      }
    })

    return ticket
  }

  private async _fireFirstAttempt(
    url: string,
    options: RequestOptions<unknown>,
    ticket: Ticket<unknown>,
    controller: TicketController<unknown>,
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
      return
    }

    let retryConfig: RetryConfig = this.mergeRetry()
    let timeoutConfig: TimeoutConfig = this.mergeTimeout(options)
    const bulkhead = this.bulkheads.get(partitionName)

    this.emit("request", { ticketId: ticket.id, url: fullUrl, method: options.method ?? "GET" })
    this.logger?.info("Request initiated", {
      ticketId: ticket.id,
      url: fullUrl,
      method: options.method ?? "GET",
      partition: partitionName,
    })
    const result = await executeRequest(
      {
        url: fullUrl,
        options,
        retryConfig,
        timeoutConfig,
        signal: ticket.signal,
      },
      this.middlewares,
    )

    switch (result.kind) {
      case "success":
        this.emit("success", { ticketId: ticket.id, url, attempt: 1 })
        this.logger?.info("Request succeeded", { ticketId: ticket.id, url })
        controller.markDone(result.result)
        return

      case "cancelled":
        controller.markDone({ success: false, error: new CancelledError() } as never)
        return

      case "error":
        // Non-retryable errors resolve immediately
        if (result.error instanceof ValidationError) {
          this.emit("failure", { ticketId: ticket.id, url, error: result.error })
          controller.markDone({ success: false, error: result.error } as never)
          return
        }
        // Let the consumer veto retrying before the request is queued
        if (this.retryVetoed(retryConfig, result.error, ticket, controller, url)) return
        controller.markQueued()
        this._scheduleInBulkhead(
          ticket,
          controller,
          url,
          options,
          retryConfig,
          timeoutConfig,
          partitionName,
          bulkhead,
        )
        return

      case "timeout": {
        const error = new TimeoutError(url, timeoutConfig.attemptMs ?? 0)
        if (this.retryVetoed(retryConfig, error, ticket, controller, url)) return
        controller.markQueued()
        this._scheduleInBulkhead(
          ticket,
          controller,
          url,
          options,
          retryConfig,
          timeoutConfig,
          partitionName,
          bulkhead,
        )
        return
      }
    }
  }

  /** Consult retryWhen after the first attempt failed (attempt 0). Returns
   *  true if the consumer vetoed retrying — the ticket is resolved with
   *  the error and must not be queued. */
  private retryVetoed(
    retryConfig: RetryConfig,
    error: AppError,
    ticket: Ticket<unknown>,
    controller: TicketController<unknown>,
    url: string,
  ): boolean {
    if (retryConfig.retryWhen && !retryConfig.retryWhen(error, 0)) {
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
    retryConfig: RetryConfig,
    timeoutConfig: TimeoutConfig,
    partitionName: string,
    bulkhead: ReturnType<BulkheadRegistry["get"]>,
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
          retryConfig,
          timeoutConfig: timeoutConfig,
          ticket,
          controller,
          middleware: this.middlewares,
          onRetry: (attempt, delayMs, error) => {
            this.emit("retry", { ticketId: ticket.id, url, attempt, delayMs, error })
          },
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
        if (err instanceof Error) {
          this.emit("failure", { ticketId: ticket.id, url, error: err })
          controller.markDone({ success: false, error: err } as never)
        }
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
    body?: BodyInit,
    options: Omit<RequestOptions<T>, "method" | "body"> = {},
  ): Ticket<T> {
    return this.request<T>(url, { ...options, method: "POST", body })
  }

  put<T>(
    url: string,
    body?: BodyInit,
    options: Omit<RequestOptions<T>, "method" | "body"> = {},
  ): Ticket<T> {
    return this.request<T>(url, { ...options, method: "PUT", body })
  }

  patch<T>(
    url: string,
    body?: BodyInit,
    options: Omit<RequestOptions<T>, "method" | "body"> = {},
  ): Ticket<T> {
    return this.request<T>(url, { ...options, method: "PATCH", body })
  }

  delete<T>(url: string, options: Omit<RequestOptions<T>, "method"> = {}): Ticket<T> {
    return this.request<T>(url, { ...options, method: "DELETE" })
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

  private mergeRetry(): RetryConfig {
    return { ...this.config.retry }
  }

  private mergeTimeout(options: RequestOptions<unknown>): TimeoutConfig {
    return {
      ...this.config.timeout,
      attemptMs: options.timeoutMs,
    } as TimeoutConfig
  }

  private emit(event: string, data: unknown): void {
    this.emitter.emit(event, data)
  }
}