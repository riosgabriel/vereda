import { EventEmitter } from "node:events";
import type {
  ClientConfig,
  LifecycleEventMap,
  Logger,
  RequestOptions,
  RetryConfig,
  TriggerConfig,
} from "./types.js";
import type { AppError } from "./errors.js";
import { NetworkError, CancelledError, TimeoutError } from "./errors.js";
import { BulkheadRegistry } from "../queue/bulkhead.js";
import { executeRequest, type MiddlewareFn } from "../queue/executor.js";
import { runRetryLoop } from "../queue/retry.js";
import { Ticket } from "../ticket/ticket.js";
import { nanoid } from "./nanoid.js";

export class HttpClient {
  private readonly config: ClientConfig;
  private readonly emitter = new EventEmitter();
  private readonly middlewares: MiddlewareFn[] = [];
  private readonly bulkheads: BulkheadRegistry;
  private readonly logger: Logger | undefined;

  private constructor(config: ClientConfig) {
    this.config = config;
    this.logger = config.logger;
    this.bulkheads = new BulkheadRegistry(
      { concurrency: config.concurrency ?? 10 },
      config.partitions ?? {}
    );
  }

  static create(config: ClientConfig = {}): HttpClient {
    return new HttpClient(config);
  }

  // ---------------------------------------------------------------------------
  // Middleware
  // ---------------------------------------------------------------------------

  use(middleware: MiddlewareFn): this {
    this.middlewares.push(middleware);
    return this;
  }

  // ---------------------------------------------------------------------------
  // Lifecycle events
  // ---------------------------------------------------------------------------

  on<K extends keyof LifecycleEventMap>(
    event: K,
    listener: (data: LifecycleEventMap[K]) => void
  ): this {
    this.emitter.on(event, listener);
    return this;
  }

  off<K extends keyof LifecycleEventMap>(
    event: K,
    listener: (data: LifecycleEventMap[K]) => void
  ): this {
    this.emitter.off(event, listener);
    return this;
  }

  // ---------------------------------------------------------------------------
  // Core request method
  // ---------------------------------------------------------------------------

  request<T>(url: string, options: RequestOptions<T> = {}): Ticket<T> {
    const fullUrl = this.resolveUrl(url);
    const ticketId = nanoid();
    const ticket = new Ticket<T>(ticketId);

    const triggerConfig = this.mergeTrigger(options);
    const retryConfig = this.mergeRetry(options);
    const partitionName = options.partition ?? new URL(fullUrl).hostname;
    const bulkhead = this.bulkheads.get(partitionName);

    this.emit("request", { ticketId, url: fullUrl, method: options.method ?? "GET" });
    this.logger?.info("Request initiated", {
      ticketId,
      url: fullUrl,
      method: options.method ?? "GET",
      partition: partitionName,
    });

    // Fire and forget — first attempt runs immediately; queued if slow/failed
    this._fireFirstAttempt(
      fullUrl,
      options as RequestOptions<unknown>,
      triggerConfig,
      retryConfig,
      ticket as Ticket<unknown>,
      partitionName,
      bulkhead
    ).catch((err: unknown) => {
      // Catch any unexpected throws and surface them as ticket failures
      const error = new NetworkError(
        err instanceof Error ? err.message : "Unexpected error",
        { cause: err }
      );
      if (ticket.status.state !== "done" && !ticket.isCancelled) {
        (ticket as Ticket<unknown>)._markDone({ success: false, error });
      }
    });

    return ticket;
  }

  private async _fireFirstAttempt(
    url: string,
    options: RequestOptions<unknown>,
    triggerConfig: TriggerConfig,
    retryConfig: RetryConfig,
    ticket: Ticket<unknown>,
    partitionName: string,
    bulkhead: ReturnType<BulkheadRegistry["get"]>
  ): Promise<void> {
    const result = await executeRequest(
      { url, options, triggerConfig, signal: ticket.signal },
      this.middlewares
    );

    switch (result.kind) {
      case "success":
        this.emit("success", { ticketId: ticket.id, url, attempt: 1 });
        this.logger?.info("Request succeeded", { ticketId: ticket.id, url });
        ticket._markDone(result.result);
        return;

      case "cancelled":
        ticket._markDone({ success: false, error: new CancelledError() });
        return;

      case "error":
        // ValidationError is not retriable — resolve immediately
        if (result.error.constructor.name === "ValidationError") {
          this.emit("failure", { ticketId: ticket.id, url, error: result.error });
          ticket._markDone({ success: false, error: result.error });
          return;
        }
        // Let the consumer veto retrying before the request is queued
        if (this.retryVetoed(retryConfig, result.error, ticket, url)) return;
        ticket._markQueued();
        this._scheduleInBulkhead(ticket, url, options, triggerConfig, retryConfig, partitionName, bulkhead);
        return;

      case "timeout":
      case "queued_status": {
        // Same error construction runRetryLoop uses for these cases
        const error = new TimeoutError(url, triggerConfig.timeoutMs ?? 0);
        if (this.retryVetoed(retryConfig, error, ticket, url)) return;
        ticket._markQueued();
        this._scheduleInBulkhead(ticket, url, options, triggerConfig, retryConfig, partitionName, bulkhead);
        return;
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
    url: string
  ): boolean {
    if (retryConfig.retryWhen && !retryConfig.retryWhen(error, 0)) {
      this.emit("failure", { ticketId: ticket.id, url, error });
      ticket._markDone({ success: false, error });
      return true;
    }
    return false;
  }

  private _scheduleInBulkhead(
    ticket: Ticket<unknown>,
    url: string,
    options: RequestOptions<unknown>,
    triggerConfig: TriggerConfig,
    retryConfig: RetryConfig,
    partitionName: string,
    bulkhead: ReturnType<BulkheadRegistry["get"]>
  ): void {
    this.logger?.info("Request queued for retry", {
      ticketId: ticket.id,
      url,
      partition: partitionName,
    });

    bulkhead
      .schedule(async () => {
        await runRetryLoop({
          url,
          requestOptions: options,
          triggerConfig,
          retryConfig,
          ticket,
          middleware: this.middlewares,
        });

        const status = ticket.status;
        if (status.state === "done") {
          if (status.result.success) {
            this.emit("success", { ticketId: ticket.id, url, attempt: -1 });
          } else {
            this.emit("failure", { ticketId: ticket.id, url, error: status.result.error });
            this.logger?.warn("Request failed after retries", {
              ticketId: ticket.id,
              url,
              error: status.result.error.message,
            });
          }
        }
      })
      .catch((err: unknown) => {
        const error = new NetworkError(
          err instanceof Error ? err.message : "Queue full",
          { cause: err }
        );
        ticket._markDone({ success: false, error });
      });
  }

  // ---------------------------------------------------------------------------
  // Convenience methods
  // ---------------------------------------------------------------------------

  get<T>(url: string, options: Omit<RequestOptions<T>, "method"> = {}): Ticket<T> {
    return this.request<T>(url, { ...options, method: "GET" });
  }

  post<T>(
    url: string,
    body?: BodyInit,
    options: Omit<RequestOptions<T>, "method" | "body"> = {}
  ): Ticket<T> {
    return this.request<T>(url, { ...options, method: "POST", body });
  }

  put<T>(
    url: string,
    body?: BodyInit,
    options: Omit<RequestOptions<T>, "method" | "body"> = {}
  ): Ticket<T> {
    return this.request<T>(url, { ...options, method: "PUT", body });
  }

  patch<T>(
    url: string,
    body?: BodyInit,
    options: Omit<RequestOptions<T>, "method" | "body"> = {}
  ): Ticket<T> {
    return this.request<T>(url, { ...options, method: "PATCH", body });
  }

  delete<T>(url: string, options: Omit<RequestOptions<T>, "method"> = {}): Ticket<T> {
    return this.request<T>(url, { ...options, method: "DELETE" });
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private resolveUrl(url: string): string {
    if (this.config.baseUrl) {
      return new URL(url, this.config.baseUrl).toString();
    }
    return url;
  }

  private mergeTrigger(options: RequestOptions<unknown>): TriggerConfig {
    return { ...this.config.trigger, ...options.trigger };
  }

  private mergeRetry(options: RequestOptions<unknown>): RetryConfig {
    return { ...this.config.retry, ...options.retry };
  }

  private emit<K extends keyof LifecycleEventMap>(event: K, data: LifecycleEventMap[K]): void {
    this.emitter.emit(event, data);
  }
}
