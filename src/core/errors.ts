export type AppError =
  | NetworkError
  | ValidationError
  | TimeoutError
  | RetryableStatusError
  | CancelledError
  | MaxRetriesExceededError

/**
 * Base class for failures that prevent a request from
 * producing a successful result.
 */
export class RequestError extends Error {
  public cause?: unknown

  constructor(message: string, cause?: unknown) {
    super(message)
    this.name = this.constructor.name
    if (cause !== undefined) {
      this.cause = cause
    }
  }
}

export class NetworkError extends RequestError {
  public readonly statusCode?: number
  public readonly response?: Response

  constructor(
    message: string,
    options?: { statusCode?: number; response?: Response; cause?: unknown },
  ) {
    super(message, options?.cause)
    this.statusCode = options?.statusCode
    this.response = options?.response
  }
}

export class ValidationError extends RequestError {
  public readonly issues: unknown[]

  constructor(message: string, issues: unknown[], cause?: unknown) {
    super(message, cause)
    this.issues = issues
  }
}

export class TimeoutError extends RequestError {
  public readonly timeoutMs: number
  public readonly url: string

  constructor(url: string, timeoutMs: number) {
    super(`Request to ${url} timed out after ${timeoutMs}ms`)
    this.timeoutMs = timeoutMs
    this.url = url
  }
}

export class RetryableStatusError extends RequestError {
  public readonly statusCode: number
  /** The original response. Its body is NOT consumed by the library; the stream remains unconsumed for caller inspection. */
  public readonly response?: Response

  constructor(statusCode: number, url: string, response?: Response) {
    super(`Request to ${url} returned retryable status ${statusCode}`)
    this.statusCode = statusCode
    this.response = response
  }
}

export class CancelledError extends RequestError {
  constructor(message = "Request was cancelled") {
    super(message)
  }
}

export class MaxRetriesExceededError extends RequestError {
  public readonly attempts: number
  public readonly lastError: AppError

  constructor(attempts: number, lastError: AppError) {
    super(
      `Request failed after ${attempts} attempt${attempts === 1 ? "" : "s"}: ${lastError.message}`,
      lastError,
    )
    this.attempts = attempts
    this.lastError = lastError
  }
}
