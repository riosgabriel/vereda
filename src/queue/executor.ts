import { HttpError, NetworkError, RetryableStatusError, ValidationError } from "../core/errors.js"
import type { AppError } from "../core/errors.js"
import type { RequestOptions, Result, RetryConfig, TimeoutConfig } from "../core/types.js"
import { DEFAULT_RETRY_ON_STATUS } from "../core/types.js"

export interface ExecuteRequest {
  url: string
  options: RequestOptions<unknown>
  timeoutConfig: TimeoutConfig
  retryConfig: RetryConfig
  signal: AbortSignal
}

export type ExecuteResult =
  | { kind: "success"; result: Result<unknown> }
  | { kind: "timeout" }
  | { kind: "cancelled" }
  | { kind: "error"; error: AppError }

/**
 * Executes a single HTTP request attempt.
 * Returns a discriminated union describing what happened,
 * so the caller (retry loop) can decide whether to retry or resolve.
 */
export async function executeRequest(
  req: ExecuteRequest,
  middleware: MiddlewareFn[],
): Promise<ExecuteResult> {
  const { url, options, timeoutConfig, retryConfig, signal } = req

  if (signal.aborted || options.signal?.aborted) {
    return { kind: "cancelled" }
  }

  const timeoutMs = timeoutConfig.attemptMs
  const retryOnStatus = retryConfig.retryOnStatus ?? [...DEFAULT_RETRY_ON_STATUS]

  // Build the fetch call wrapped in middleware
  const fetchCall = buildFetchCall(url, options)
  const composed = composeMiddleware(middleware, fetchCall)

  // Race against timeout if configured
  let response: Response
  try {
    if (timeoutMs !== undefined) {
      const timeoutController = new AbortController()
      const timeoutId = setTimeout(() => timeoutController.abort(), timeoutMs)

      // Merge signals: external cancel + timeout
      const mergedSignal = mergeSignals(
        signal,
        timeoutController.signal,
        ...(options.signal ? [options.signal] : []),
      )

      try {
        response = await composed({ ...options, signal: mergedSignal })
      } finally {
        clearTimeout(timeoutId)
      }

      if (timeoutController.signal.aborted) {
        return { kind: "timeout" }
      }
    } else {
      const mergedSignal = options.signal ? mergeSignals(signal, options.signal) : signal
      response = await composed({ ...options, signal: mergedSignal })
    }
  } catch (err) {
    // Precedence: cancellation wins over timeout. If the ticket or the
    // external signal is aborted, report cancelled even if the timeout
    // also fired — the ticket is already marked cancelled, and
    // cancellation is the caller's terminal intent. A timeout that fires
    // first still surfaces as "timeout": the external signal is not yet
    // aborted when this check runs.
    if (signal.aborted || options.signal?.aborted) {
      return { kind: "cancelled" }
    }
    if (isAbortError(err)) {
      // Could be our timeout abort
      return { kind: "timeout" }
    }
    return {
      kind: "error",
      error: new NetworkError(err instanceof Error ? err.message : "Network error", { cause: err }),
    }
  }

  // Check if status code is retryable (was "queued_status", now typed error)
  if (retryOnStatus.includes(response.status)) {
    // Cancel the response body since caller won't read it
    try {
      await response.body?.cancel()
    } catch {
      /* ignore — best effort */
    }
    return {
      kind: "error",
      error: new RetryableStatusError(
        `HTTP ${response.status} ${response.statusText}`,
        response.status,
        response,
      ),
    }
  }

  // Non-2xx responses are non-retryable errors
  if (!response.ok) {
    return {
      kind: "error",
      error: new HttpError(
        `HTTP ${response.status} ${response.statusText}`,
        response.status,
        response,
      ),
    }
  }

  // Parse body
  if (options.parse) {
    let raw: unknown
    try {
      raw = await response.json()
    } catch (err) {
      return {
        kind: "error",
        error: new NetworkError("Failed to parse response body as JSON", {
          cause: err,
        }),
      }
    }

    try {
      const data = options.parse(raw)
      return {
        kind: "success",
        result: { success: true, data, raw: response },
      }
    } catch (err) {
      const issues = extractIssues(err)
      return {
        kind: "error",
        error: new ValidationError("Response validation failed", issues, err),
      }
    }
  }

  // No parse fn — return raw response
  return {
    kind: "success",
    result: { success: true, data: undefined, raw: response },
  }
}

// ---------------------------------------------------------------------------
// Middleware types + composition
// ---------------------------------------------------------------------------

export type NextFn = (options: RequestOptions<unknown>) => Promise<Response>
export type MiddlewareFn = (options: RequestOptions<unknown>, next: NextFn) => Promise<Response>

function buildFetchCall(url: string, _baseOptions: RequestOptions<unknown>): NextFn {
  return async (options: RequestOptions<unknown>): Promise<Response> => {
    return fetch(url, {
      method: options.method ?? "GET",
      headers: options.headers,
      body: options.body,
      signal: options.signal,
    })
  }
}

export function composeMiddleware(middlewares: MiddlewareFn[], core: NextFn): NextFn {
  return middlewares.reduceRight<NextFn>(
    (next, middleware) => (options) => middleware(options, next),
    core,
  )
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError"
}

function mergeSignals(...signals: AbortSignal[]): AbortSignal {
  const controller = new AbortController()
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort()
      break
    }
    signal.addEventListener("abort", () => controller.abort(), { once: true })
  }
  return controller.signal
}

function extractIssues(err: unknown): unknown[] {
  if (err && typeof err === "object" && "errors" in err) {
    return (err as { errors: unknown[] }).errors
  }
  if (err && typeof err === "object" && "issues" in err) {
    return (err as { issues: unknown[] }).issues
  }
  return [err]
}
