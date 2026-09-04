import type { AppError } from "../core/errors.js";
import {
  ConfigurationError,
  HttpError,
  NetworkError,
  RetryableStatusError,
  ValidationError,
} from "../core/errors.js";
import type { RequestOptions, Result, RetryConfig, TimeoutConfig } from "../core/types.js";
import { DEFAULT_RETRY_ON_STATUS } from "../core/types.js";
import { isReadableStream } from "../core/validate.js";

export interface ExecuteRequest {
  url: string;
  options: RequestOptions<unknown>;
  timeoutConfig: TimeoutConfig;
  retryConfig: RetryConfig;
  signal: AbortSignal;
}

export type ExecuteResult =
  | { kind: "success"; result: Result<unknown> }
  | { kind: "timeout" }
  | { kind: "cancelled" }
  | { kind: "error"; error: AppError };

/**
 * Executes a single HTTP request attempt.
 * Returns a discriminated union describing what happened,
 * so the caller (retry loop) can decide whether to retry or resolve.
 */
export async function executeRequest(
  req: ExecuteRequest,
  middleware: MiddlewareFn[],
): Promise<ExecuteResult> {
  const { url, options, timeoutConfig, retryConfig, signal } = req;

  if (signal.aborted || options.signal?.aborted) {
    return { kind: "cancelled" };
  }

  // Resolve a replayable body factory fresh for this attempt so every attempt
  // gets its own materialized body. Do not mutate the caller's options.
  let resolvedBody: BodyInit | undefined;
  if (typeof options.body === "function") {
    try {
      resolvedBody = (options.body as () => BodyInit)();
    } catch (err) {
      return {
        kind: "error",
        error: new ConfigurationError(
          `body factory threw: ${err instanceof Error ? err.message : String(err)}`,
        ),
      };
    }
  } else {
    resolvedBody = options.body;
  }
  const resolvedOptions = { ...options, body: resolvedBody };

  const timeoutMs = timeoutConfig.attemptMs;
  const retryOnStatus = retryConfig.retryOnStatus ?? DEFAULT_RETRY_ON_STATUS;

  // Build the fetch call wrapped in middleware
  const fetchCall = buildFetchCall(url, resolvedOptions);
  const composed = composeMiddleware(middleware, fetchCall);

  // Merge the per-attempt signals with AbortSignal.any. It wires its sources
  // internally (no "abort" listeners attached to them), so neither the ticket
  // signal nor the caller's signal accumulates one listener per attempt (#7).
  // Wrapping even a lone ticket signal shields it from fetch's own abort
  // listener, which undici only removes asynchronously after completion.
  const sources: AbortSignal[] = [signal];
  if (options.signal) sources.push(options.signal);
  const timeoutController = timeoutMs === undefined ? undefined : new AbortController();
  if (timeoutController) sources.push(timeoutController.signal);
  const attemptSignal = AbortSignal.any(sources);
  const timeoutId =
    timeoutController && timeoutMs !== undefined
      ? setTimeout(() => timeoutController.abort(), timeoutMs)
      : undefined;

  let response: Response;
  try {
    response = await composed({ ...resolvedOptions, signal: attemptSignal });
    // The timeout may fire after fetch resolves but before this check runs;
    // the timed-out attempt is not trustworthy, so it still surfaces as a
    // timeout (cancellation is checked first in the catch path below).
    if (timeoutController?.signal.aborted) {
      return { kind: "timeout" };
    }

    // Check if status code is retryable (was "queued_status", now typed error)
    if (retryOnStatus.includes(response.status)) {
      // Cancel the response body since caller won't read it.
      // Fire-and-forget: cancel() may hang on stuck connections.
      // The body will be GC'd when the response is collected.
      response.body?.cancel().catch(() => {});
      return {
        kind: "error",
        error: new RetryableStatusError(
          `HTTP ${response.status} ${response.statusText}`,
          response.status,
          response,
          parseRetryAfter(response.headers.get("retry-after")),
        ),
      };
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
      };
    }

    // Parse body — the timeout is still active so a slow body read is
    // covered by the per-attempt deadline (#9).
    if (options.parse) {
      let raw: unknown;
      try {
        raw = await response.json();
      } catch (err) {
        // Check timeout first — if our timer fired during response.json(),
        // that is the cause regardless of whether the external signal also
        // aborted (cancellation vs timeout precedence).
        if (timeoutController?.signal.aborted) {
          return { kind: "timeout" };
        }
        if (signal.aborted || options.signal?.aborted) {
          return { kind: "cancelled" };
        }
        return {
          kind: "error",
          error: new NetworkError("Failed to parse response body as JSON", {
            cause: err,
          }),
        };
      }

      try {
        const data = options.parse(raw);
        return {
          kind: "success",
          result: { success: true, data, raw: response },
        };
      } catch (err) {
        const issues = extractIssues(err);
        return {
          kind: "error",
          error: new ValidationError("Response validation failed", issues, err),
        };
      }
    }

    // No parse fn — return raw response
    return {
      kind: "success",
      result: { success: true, data: undefined, raw: response },
    };
  } catch (err) {
    // Precedence: cancellation wins over timeout. If the ticket or the
    // external signal is aborted, report cancelled even if the timeout
    // also fired — the ticket is already marked cancelled, and
    // cancellation is the caller's terminal intent. A timeout that fires
    // first still surfaces as "timeout": the external signal is not yet
    // aborted when this check runs.
    if (signal.aborted || options.signal?.aborted) {
      return { kind: "cancelled" };
    }
    if (isAbortError(err)) {
      // Could be our timeout abort
      return { kind: "timeout" };
    }
    return {
      kind: "error",
      error: new NetworkError(err instanceof Error ? err.message : "Network error", { cause: err }),
    };
  } finally {
    // Clear the timeout once the attempt is complete — body has been read
    // (or the attempt failed), so the abort controller can be released.
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}

// ---------------------------------------------------------------------------
// Middleware types + composition
// ---------------------------------------------------------------------------

export type NextFn = (options: RequestOptions<unknown>) => Promise<Response>;
export type MiddlewareFn = (options: RequestOptions<unknown>, next: NextFn) => Promise<Response>;

function buildFetchCall(url: string, _baseOptions: RequestOptions<unknown>): NextFn {
  return async (options: RequestOptions<unknown>): Promise<Response> => {
    const body = options.body as BodyInit | undefined;
    const init: RequestInit = {
      method: options.method ?? "GET",
      headers: options.headers,
      body,
      signal: options.signal,
    };
    if (isReadableStream(body)) {
      // Node's fetch requires duplex: "half" for stream bodies.
      (init as { duplex?: "half" }).duplex = "half";
    }
    return fetch(url, init);
  };
}

export function composeMiddleware(middlewares: MiddlewareFn[], core: NextFn): NextFn {
  return middlewares.reduceRight<NextFn>(
    (next, middleware) => (options) => middleware(options, next),
    core,
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Parse a `Retry-After` header value into a delay in ms, or undefined when
 *  absent/unparseable. Integer seconds → ms; HTTP-date → ms from now, clamped
 *  to ≥ 0; anything else (garbage, negative) → undefined. */
export function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const trimmed = header.trim();
  if (/^\d+$/.test(trimmed)) {
    return Number(trimmed) * 1000;
  }
  const parsed = Date.parse(trimmed);
  if (Number.isNaN(parsed)) return undefined;
  return Math.max(0, parsed - Date.now());
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}

function extractIssues(err: unknown): unknown[] {
  if (err && typeof err === "object" && "errors" in err) {
    return (err as { errors: unknown[] }).errors;
  }
  if (err && typeof err === "object" && "issues" in err) {
    return (err as { issues: unknown[] }).issues;
  }
  return [err];
}
