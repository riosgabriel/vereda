export type AppError =
  | NetworkError
  | ValidationError
  | TimeoutError
  | CancelledError
  | MaxRetriesExceededError;

export class RelayError extends Error {
  public cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = this.constructor.name;
    if (cause !== undefined) {
      this.cause = cause;
    }
  }
}

export class NetworkError extends RelayError {
  public readonly statusCode?: number;
  public readonly response?: Response;

  constructor(
    message: string,
    options?: { statusCode?: number; response?: Response; cause?: unknown }
  ) {
    super(message, options?.cause);
    this.statusCode = options?.statusCode;
    this.response = options?.response;
  }
}

export class ValidationError extends RelayError {
  public readonly issues: unknown[];

  constructor(message: string, issues: unknown[], cause?: unknown) {
    super(message, cause);
    this.issues = issues;
  }
}

export class TimeoutError extends RelayError {
  public readonly timeoutMs: number;
  public readonly url: string;

  constructor(url: string, timeoutMs: number) {
    super(`Request to ${url} timed out after ${timeoutMs}ms`);
    this.timeoutMs = timeoutMs;
    this.url = url;
  }
}

export class CancelledError extends RelayError {
  constructor(message = "Request was cancelled") {
    super(message);
  }
}

export class MaxRetriesExceededError extends RelayError {
  public readonly attempts: number;
  public readonly lastError: AppError;

  constructor(attempts: number, lastError: AppError) {
    super(
      `Request failed after ${attempts} attempt${attempts === 1 ? "" : "s"}: ${lastError.message}`,
      lastError
    );
    this.attempts = attempts;
    this.lastError = lastError;
  }
}
