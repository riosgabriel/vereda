export type AppError =
  | NetworkError
  | HttpError
  | RetryableStatusError
  | TimeoutError
  | ValidationError
  | CancelledError
  | QueueFullError
  | ConfigurationError
  | MaxRetriesExceededError

/**
 * Base class for failures that prevent a request from
 * producing a successful result.
 */
export class RequestError extends Error {
  public readonly kind: string
  public cause?: unknown

  constructor(kind: string, message: string, cause?: unknown) {
    super(message)
    this.name = this.constructor.name
    this.kind = kind
    if (cause !== undefined) {
      this.cause = cause
    }
  }
}

export class NetworkError extends RequestError {
  constructor(message: string, options?: { cause?: unknown }) {
    super("network", message, options?.cause)
  }
}

export class HttpError extends RequestError {
  public readonly statusCode: number
  public readonly response: Response

  constructor(message: string, statusCode: number, response: Response) {
    super("http", message)
    this.statusCode = statusCode
    this.response = response
  }
}

export class RetryableStatusError extends RequestError {
  public readonly statusCode: number
  public readonly response: Response
  public readonly retryAfterMs?: number

  constructor(message: string, statusCode: number, response: Response, retryAfterMs?: number) {
    super("retryable_status", message)
    this.statusCode = statusCode
    this.response = response
    this.retryAfterMs = retryAfterMs
  }
}

export class TimeoutError extends RequestError {
  public readonly timeoutMs: number
  public readonly url: string

  constructor(url: string, timeoutMs: number) {
    super("timeout", `Request to ${url} timed out after ${timeoutMs}ms`)
    this.timeoutMs = timeoutMs
    this.url = url
  }
}

export class ValidationError extends RequestError {
  public readonly issues: unknown[]

  constructor(message: string, issues: unknown[], cause?: unknown) {
    super("validation", message, cause)
    this.issues = issues
  }
}

export class CancelledError extends RequestError {
  constructor(message = "Request was cancelled") {
    super("cancelled", message)
  }
}

export class QueueFullError extends RequestError {
  public readonly partition: string
  public readonly queueSize: number
  public readonly maxQueueSize: number

  constructor(partition: string, queueSize: number, maxQueueSize: number) {
    super("queue_full", `Queue for partition '${partition}' is full (${queueSize}/${maxQueueSize})`)
    this.partition = partition
    this.queueSize = queueSize
    this.maxQueueSize = maxQueueSize
  }
}

export class ConfigurationError extends RequestError {
  public readonly key: string

  constructor(key: string) {
    super("configuration", `Invalid configuration: ${key}`)
    this.key = key
  }
}

export class MaxRetriesExceededError extends RequestError {
  public readonly attempts: number
  public readonly lastError: AppError

  constructor(attempts: number, lastError: AppError) {
    super(
      "max_retries",
      `Request failed after ${attempts} attempt${attempts === 1 ? "" : "s"}: ${lastError.message}`,
      lastError,
    )
    this.attempts = attempts
    this.lastError = lastError
  }
}
