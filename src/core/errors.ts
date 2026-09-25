export type AppError =
	| NetworkError
	| HttpError
	| RetryableStatusError
	| TimeoutError
	| DeadlineExceededError
	| ValidationError
	| CancelledError
	| QueueFullError
	| ConfigurationError
	| MaxRetriesExceededError
	| CircuitOpenError;

/**
 * Base class for failures that prevent a request from
 * producing a successful result.
 */
export class RequestError extends Error {
	public readonly kind: string;
	public cause?: unknown;

	constructor(kind: string, message: string, cause?: unknown) {
		super(message);
		this.name = this.constructor.name;
		this.kind = kind;
		if (cause !== undefined) {
			this.cause = cause;
		}
	}
}

export class NetworkError extends RequestError {
	declare readonly kind: "network";

	constructor(message: string, options?: { cause?: unknown }) {
		super("network", message, options?.cause);
	}
}

export class HttpError extends RequestError {
	declare readonly kind: "http";
	public readonly statusCode: number;
	public readonly response: Response;

	constructor(message: string, statusCode: number, response: Response) {
		super("http", message);
		this.statusCode = statusCode;
		this.response = response;
	}
}

export class RetryableStatusError extends RequestError {
	declare readonly kind: "retryable_status";
	public readonly statusCode: number;
	public readonly response: Response;
	public readonly retryAfterMs?: number;

	constructor(message: string, statusCode: number, response: Response, retryAfterMs?: number) {
		super("retryable_status", message);
		this.statusCode = statusCode;
		this.response = response;
		if (retryAfterMs !== undefined) {
			this.retryAfterMs = retryAfterMs;
		}
	}
}

/** Sentinel `timeoutMs` value reported on `TimeoutError` when no per-attempt
 *  timeout (`TimeoutConfig.attemptMs`) was configured. Callers that construct
 *  a `TimeoutError` for an unconfigured timeout should pass this instead of
 *  a bare `0` so there is one place this convention is spelled out. */
export const NO_TIMEOUT_CONFIGURED = 0;

export class TimeoutError extends RequestError {
	declare readonly kind: "timeout";
	public readonly timeoutMs: number;
	public readonly url: string;

	constructor(url: string, timeoutMs: number) {
		const message =
			timeoutMs > NO_TIMEOUT_CONFIGURED
				? `Request to ${url} timed out after ${timeoutMs}ms`
				: `Request to ${url} timed out (no timeout configured)`;
		super("timeout", message);
		this.timeoutMs = timeoutMs;
		this.url = url;
	}
}

export class DeadlineExceededError extends RequestError {
	declare readonly kind: "deadline";
	public readonly url: string;
	public readonly totalMs: number;

	constructor(url: string, totalMs: number) {
		super("deadline", `Request to ${url} exceeded total deadline of ${totalMs}ms`);
		this.url = url;
		this.totalMs = totalMs;
	}
}

export class ValidationError extends RequestError {
	declare readonly kind: "validation";
	public readonly issues: unknown[];

	constructor(message: string, issues: unknown[], cause?: unknown) {
		super("validation", message, cause);
		this.issues = issues;
	}
}

export class CancelledError extends RequestError {
	declare readonly kind: "cancelled";

	constructor(message = "Request was cancelled") {
		super("cancelled", message);
	}
}

export class QueueFullError extends RequestError {
	declare readonly kind: "queue_full";
	public readonly partition: string;
	public readonly queueSize: number;
	public readonly maxQueueSize: number;

	constructor(partition: string, queueSize: number, maxQueueSize: number) {
		super("queue_full", `Queue for partition '${partition}' is full (${queueSize}/${maxQueueSize})`);
		this.partition = partition;
		this.queueSize = queueSize;
		this.maxQueueSize = maxQueueSize;
	}
}

export class ConfigurationError extends RequestError {
	declare readonly kind: "configuration";
	public readonly key: string;

	constructor(key: string) {
		super("configuration", `Invalid configuration: ${key}`);
		this.key = key;
	}
}

export class MaxRetriesExceededError extends RequestError {
	declare readonly kind: "max_retries";
	public readonly attempts: number;
	public readonly lastError: AppError;

	constructor(attempts: number, lastError: AppError) {
		super(
			"max_retries",
			`Request failed after ${attempts} attempt${attempts === 1 ? "" : "s"}: ${lastError.message}`,
			lastError,
		);
		this.attempts = attempts;
		this.lastError = lastError;
	}
}

export class CircuitOpenError extends RequestError {
	declare readonly kind: "circuit_open";
	public readonly partition: string;

	constructor(partition: string) {
		super("circuit_open", `Circuit breaker is open for partition '${partition}'`);
		this.partition = partition;
	}
}

/**
 * Narrows an unknown throw to one of this library's own error classes, so
 * internal catch sites can preserve a pre-typed failure (e.g. a
 * `QueueFullError` from the bulkhead) and wrap anything else.
 */
export function isAppError(err: unknown): err is AppError {
	// instanceof, not a `kind` lookup: a subclass of one of these still carries
	// its fields (e.g. statusCode), whereas a bare RequestError with a matching
	// kind string would not.
	return APP_ERROR_CLASSES.some((cls) => err instanceof cls);
}

const APP_ERROR_CLASSES = [
	NetworkError,
	HttpError,
	RetryableStatusError,
	TimeoutError,
	DeadlineExceededError,
	ValidationError,
	CancelledError,
	QueueFullError,
	ConfigurationError,
	MaxRetriesExceededError,
	CircuitOpenError,
] as const;
