import type { AppError } from "../core/errors.ts";
import {
	ConfigurationError,
	DeadlineExceededError,
	HttpError,
	NetworkError,
	NO_TIMEOUT_CONFIGURED,
	RetryableStatusError,
	TimeoutError,
	ValidationError,
} from "../core/errors.ts";
import type { RedirectMode, RequestOptions, ResponseType, Result, RetryConfig, TimeoutConfig } from "../core/types.ts";
import { DEFAULT_RETRY_ON_STATUS, isBoundedMs } from "../core/types.ts";
import { isReadableStream } from "../core/validate.ts";

export interface ExecuteRequest {
	url: string;
	options: RequestOptions<unknown>;
	timeoutConfig: TimeoutConfig;
	retryConfig: RetryConfig;
	signal: AbortSignal;
	/** Which attempt this is: 0 = the first attempt, 1 = the first retry, etc.
	 *  Exposed to middleware via `RequestContext.attempt`. */
	attempt: number;
	ticketId: string;
	partition: string;
	/** Absolute `Date.now()` timestamp of the ticket's whole-ticket deadline
	 *  (`startTime + timeout.totalMs`), or undefined when `totalMs` isn't
	 *  bounded. Used only to bound the read window of a Response handed back
	 *  to the caller unread (see `handedOff` in `executeRequest`) — never to
	 *  reclassify an in-attempt timeout. */
	deadlineAt?: number;
	/** `url` as it may appear in errors/logs (query- and userinfo-redacted
	 *  unless disabled) — used to build the `TimeoutError`/`DeadlineExceededError`
	 *  that bounds a handed-off Response's body-read window, so that error is
	 *  redacted the same as every other error the client builds. */
	displayUrl: string;
	/** Custom fetch function. Falls back to globalThis.fetch. */
	fetch?: typeof globalThis.fetch;
	/** Client-level redirect mode; seeds `RequestContext.redirect`. */
	redirect?: RedirectMode;
}

export type ExecuteResult =
	| { kind: "success"; result: Extract<Result<unknown>, { success: true }> }
	| { kind: "timeout" }
	| { kind: "cancelled" }
	| { kind: "error"; error: AppError };

/**
 * Executes a single HTTP request attempt.
 * Returns a discriminated union describing what happened,
 * so the caller (retry loop) can decide whether to retry or resolve.
 */
export async function executeRequest(req: ExecuteRequest, middleware: MiddlewareFn[]): Promise<ExecuteResult> {
	const { url, options, timeoutConfig, retryConfig, signal } = req;
	const attemptStart = Date.now();

	if (signal.aborted || options.signal?.aborted) {
		return { kind: "cancelled" };
	}

	// Set once this attempt hands the caller a live, unread Response body (the
	// success-without-parse and HttpError returns below). An unconsumed body
	// handed off this way gets bounded in `finally` instead of having its
	// timer cleared, so `raw.json()`/`error.response.text()` read later can't
	// hang forever (the parse path already reads the body inside the attempt,
	// and the RetryableStatusError path already cancels it).
	let handedOff = false;

	// Resolve a replayable body factory fresh for this attempt so every attempt
	// gets its own materialized body. Do not mutate the caller's options.
	let resolvedBody: BodyInit | undefined;
	if (typeof options.body === "function") {
		try {
			resolvedBody = (options.body as () => BodyInit)();
		} catch (err) {
			return {
				kind: "error",
				error: new ConfigurationError(`body factory threw: ${err instanceof Error ? err.message : String(err)}`),
			};
		}
	} else {
		resolvedBody = options.body;
	}
	const timeoutMs = timeoutConfig.attemptMs;
	const retryOnStatus = retryConfig.retryOnStatus ?? DEFAULT_RETRY_ON_STATUS;

	// Build the fetch call wrapped in middleware
	const fetchCall = buildFetchCall(req.fetch);
	const composed = composeMiddleware(middleware, fetchCall);

	// Merge the per-attempt signals with AbortSignal.any. It wires its sources
	// internally (no "abort" listeners attached to them), so neither the ticket
	// signal nor the caller's signal accumulates one listener per attempt (#7).
	// Wrapping even a lone ticket signal shields it from fetch's own abort
	// listener, which undici only removes asynchronously after completion.
	const sources: AbortSignal[] = [signal];
	if (options.signal) sources.push(options.signal);
	// `Infinity` is a legal, explicit "no cap" value (see isBoundedMs) — it must
	// be treated the same as "not set" here. Node clamps any setTimeout delay
	// over ~24.8 days to 1ms, so passing Infinity straight to setTimeout would
	// fire the timer almost immediately instead of never.
	const hasAttemptTimeout = isBoundedMs(timeoutMs);
	// Always created (not just when attemptMs is bounded): a handed-off
	// Response's body read may still need bounding by `deadlineAt` alone in
	// `finally` below, even when this attempt itself has no attemptMs cap.
	const timeoutController = new AbortController();
	sources.push(timeoutController.signal);
	const attemptSignal = AbortSignal.any(sources);
	const timeoutId = hasAttemptTimeout ? setTimeout(() => timeoutController.abort(), timeoutMs) : undefined;
	timeoutId?.unref?.();

	// A fresh Headers instance per attempt: middleware (e.g. defaultHeaders)
	// mutates ctx.headers in place, and that must never leak into the next
	// retry's "starting" headers.
	const ctx: RequestContext = {
		url,
		method: options.method ?? "GET",
		headers: new Headers(options.headers),
		body: resolvedBody,
		signal: attemptSignal,
		attempt: req.attempt,
		ticketId: req.ticketId,
		partition: req.partition,
		redirect: req.redirect,
	};

	let response: Response;
	try {
		const pending = composed(ctx);
		response = await settleOnAbort(pending, attemptSignal, () => {
			void discard(pending);
		});
		// An abort may land after fetch resolves but before this check runs
		// (e.g. while middleware post-processes the response). The attempt is
		// abandoned, so release its body: a transport that ignores the signal
		// would otherwise hold the socket until GC (B13). Same precedence as the
		// catch path: cancellation wins over timeout.
		if (signal.aborted || options.signal?.aborted) {
			response.body?.cancel().catch(() => {});
			return { kind: "cancelled" };
		}
		if (timeoutController.signal.aborted) {
			response.body?.cancel().catch(() => {});
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

		// Non-2xx responses are non-retryable errors. The body is handed back
		// unread on `error.response` — bound its read window in `finally`.
		if (!response.ok) {
			handedOff = true;
			return {
				kind: "error",
				error: new HttpError(`HTTP ${response.status} ${response.statusText}`, response.status, response),
			};
		}

		// Read the body (and run `parse`) inside the attempt — the timeout is
		// still active, so a slow read or a hung async parse is covered by the
		// per-attempt deadline (#9, #142).
		const responseType = options.responseType ?? (options.parse ? "json" : undefined);
		if (responseType !== undefined) {
			let raw: unknown;
			try {
				raw = await readBody(response, responseType, attemptSignal);
			} catch (err) {
				// Check timeout first — if our timer fired during the read, that is
				// the cause regardless of whether the external signal also aborted
				// (cancellation vs timeout precedence).
				if (timeoutController.signal.aborted) {
					return { kind: "timeout" };
				}
				if (signal.aborted || options.signal?.aborted) {
					return { kind: "cancelled" };
				}
				// The body arrived but isn't JSON: the server answered, and asking
				// again will get the same answer — a parse failure, never retried
				// (B6). Anything else here is the body stream dying mid-read
				// (undici's "terminated" TypeError), which is a real network error.
				if (err instanceof SyntaxError) {
					return {
						kind: "error",
						error: new ValidationError("Response body is not valid JSON", [err], err),
					};
				}
				return {
					kind: "error",
					error: new NetworkError("Failed to read response body", {
						cause: err,
					}),
				};
			}

			const parse = options.parse;
			if (!parse) {
				return { kind: "success", result: { success: true, data: raw, raw: response } };
			}
			try {
				// `then` turns a sync throw into a rejection, so both paths land in
				// the catch below.
				const data = await settleOnAbort(Promise.resolve(raw).then(parse), attemptSignal);
				return {
					kind: "success",
					result: { success: true, data, raw: response },
				};
			} catch (err) {
				// An abort that lands mid-parse ends the attempt like one mid-read:
				// the deadline bounds every await in an attempt. Only a parse that
				// actually threw or rejected is a validation failure.
				if (timeoutController.signal.aborted) {
					return { kind: "timeout" };
				}
				if (signal.aborted || options.signal?.aborted) {
					return { kind: "cancelled" };
				}
				const issues = extractIssues(err);
				return {
					kind: "error",
					error: new ValidationError("Response validation failed", issues, err),
				};
			}
		}

		// No parse fn — return raw response, unread. Bound its read window in
		// `finally` instead of clearing the attempt timer.
		handedOff = true;
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
		// Classify by which signal actually aborted, not by the thrown error's
		// shape: middleware may wrap/rethrow the abort error (losing its
		// `AbortError` name), and the attempt's own timeout controller is the
		// authority on whether the attempt timed out.
		if (timeoutController.signal.aborted) {
			return { kind: "timeout" };
		}
		return {
			kind: "error",
			error: new NetworkError(err instanceof Error ? err.message : "Network error", { cause: err }),
		};
	} finally {
		// Clear the in-attempt timer either way — it did its job (bounding the
		// attempt) or the attempt failed on its own. Body has been read (or the
		// attempt failed), so the abort controller can be released.
		if (timeoutId !== undefined) clearTimeout(timeoutId);

		// A handed-off Response (unread body on a success-without-parse or
		// HttpError result) gets the same bound its body would have had under
		// `parse`: arm a fresh timer capped at whichever is sooner, this
		// attempt's remaining attemptMs or the ticket's totalMs deadline. It
		// fires only if the caller actually reads the body later — aborting
		// `attemptSignal` (already wired into fetch) makes that read reject,
		// same as any other abort observed after fetch() has resolved. No
		// ticket state changes here: the ticket already resolved.
		if (handedOff) {
			const attemptTimeoutMs = isBoundedMs(timeoutMs) ? timeoutMs : undefined;
			const attemptDeadline =
				attemptTimeoutMs !== undefined ? attemptStart + attemptTimeoutMs : Number.POSITIVE_INFINITY;
			const totalDeadline = req.deadlineAt ?? Number.POSITIVE_INFINITY;
			const boundAt = Math.min(attemptDeadline, totalDeadline);
			if (Number.isFinite(boundAt)) {
				const delay = Math.max(0, boundAt - Date.now());
				// Name the abort reason after whichever bound fired — ties go to the
				// attempt bound, since it's also the only bound when totalMs isn't
				// configured — using Vereda's own error classes instead of a bare
				// DOMException. That way a caller's `raw.json()`/`error.response.text()`
				// rejects with something `instanceof TimeoutError`/`DeadlineExceededError`,
				// `.kind`-narrowable, and redacted the same as every other error the
				// client builds. The final branch is defensive only: `boundAt` being
				// finite guarantees one of the two bounds above is actually configured.
				const reason =
					attemptTimeoutMs !== undefined && attemptDeadline <= totalDeadline
						? new TimeoutError(req.displayUrl, attemptTimeoutMs)
						: isBoundedMs(req.timeoutConfig.totalMs)
							? new DeadlineExceededError(req.displayUrl, req.timeoutConfig.totalMs)
							: new TimeoutError(req.displayUrl, attemptTimeoutMs ?? NO_TIMEOUT_CONFIGURED);
				const bodyReadTimer = setTimeout(() => {
					timeoutController.abort(reason);
				}, delay);
				bodyReadTimer.unref?.();
			}
		}
	}
}

// ---------------------------------------------------------------------------
// Middleware types + composition
// ---------------------------------------------------------------------------

/** What a middleware function sees and can rewrite for a single attempt.
 *  `headers` is a real `Headers` instance (case-insensitive lookups/sets) and
 *  is fresh per attempt — mutating it does not affect other attempts or the
 *  caller's original `RequestOptions`. */
export interface RequestContext {
	url: string;
	method: string;
	headers: Headers;
	body?: BodyInit;
	signal: AbortSignal;
	/** 0 = the first attempt, 1 = the first retry, etc. */
	attempt: number;
	ticketId: string;
	partition: string;
	/** The client's `redirect` mode, or undefined for fetch's default
	 *  (`"follow"`). Middleware may read or override it per attempt. */
	redirect?: RedirectMode;
}

export type NextFn = (ctx: RequestContext) => Promise<Response>;
export type MiddlewareFn = (ctx: RequestContext, next: NextFn) => Promise<Response>;

function buildFetchCall(customFetch?: typeof globalThis.fetch): NextFn {
	const fetchFn = customFetch ?? globalThis.fetch.bind(globalThis);
	return async (ctx: RequestContext): Promise<Response> => {
		const init: RequestInit = {
			method: ctx.method,
			headers: ctx.headers,
			body: ctx.body,
			signal: ctx.signal,
		};
		// Only set when configured, so a custom fetch sees fetch's own default.
		if (ctx.redirect !== undefined) init.redirect = ctx.redirect;
		if (isReadableStream(ctx.body)) {
			// Node's fetch requires duplex: "half" for stream bodies.
			(init as { duplex?: "half" }).duplex = "half";
		}
		return fetchFn(ctx.url, init);
	};
}

export function composeMiddleware(middlewares: MiddlewareFn[], core: NextFn): NextFn {
	return middlewares.reduceRight<NextFn>((next, middleware) => (ctx) => middleware(ctx, next), core);
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

/** `pending`, but it rejects with `signal.reason` as soon as `signal` aborts.
 *  Ending the attempt relies on the transport honoring the signal otherwise:
 *  a custom `fetch` or middleware that drops it would leave the attempt
 *  pending forever, past `attemptMs`, `totalMs` and `cancel()`, so the ticket's
 *  terminal event would never fire (#181). The same holds for an async
 *  `parse`, which has no signal at all. The abandoned promise is left to
 *  settle on its own; `release` cleans up after it (by default, it swallows a
 *  late rejection; for fetch, it cancels the late Response's body so the
 *  connection is released, B13). */
function settleOnAbort<T>(
	pending: Promise<T>,
	signal: AbortSignal,
	release: () => void = () => {
		pending.catch(() => {});
	},
): Promise<T> {
	if (signal.aborted) {
		release();
		return Promise.reject(signal.reason);
	}
	return new Promise((resolve, reject) => {
		const onAbort = () => {
			release();
			reject(signal.reason);
		};
		signal.addEventListener("abort", onAbort, { once: true });
		pending.then(
			(value) => {
				signal.removeEventListener("abort", onAbort);
				resolve(value);
			},
			(err: unknown) => {
				signal.removeEventListener("abort", onAbort);
				reject(err);
			},
		);
	});
}

/** Waits out an abandoned fetch: cancels the body of a Response it resolves
 *  to, and swallows a rejection nobody is listening for anymore. */
async function discard(pending: Promise<Response>): Promise<void> {
	try {
		await (await pending).body?.cancel();
	} catch {
		// Abandoned: a late failure or a failed cancel has no one to report to.
	}
}

/** Reads the body as `responseType`, stopping when `signal` aborts. The
 *  built-in readers (`json()`, `text()`, …) rely on the transport tying the
 *  body to the fetch signal; a custom `fetch` or middleware that drops the
 *  signal would leave them reading forever, past `attemptMs`/`totalMs` (B13).
 *  They also hold the reader lock, so `body.cancel()` can't stop them — owning
 *  the reader can. Decoding matches the built-ins: UTF-8 with a leading BOM
 *  stripped, and `"json"` throws `SyntaxError` on malformed or empty input
 *  (B6 relies on that). `"none"` cancels the body unread. */
async function readBody(response: Response, responseType: ResponseType, signal: AbortSignal): Promise<unknown> {
	if (responseType === "none") {
		response.body?.cancel().catch(() => {});
		return undefined;
	}
	const bytes = await readBytes(response, signal);
	switch (responseType) {
		case "json":
			return JSON.parse(new TextDecoder().decode(bytes));
		case "text":
			return new TextDecoder().decode(bytes);
		case "arrayBuffer":
			return bytes.buffer;
		case "blob":
			return new Blob([bytes], { type: response.headers.get("content-type") ?? "" });
	}
}

async function readBytes(response: Response, signal: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
	if (!response.body) return new Uint8Array(0);
	const reader = response.body.getReader();
	const onAbort = () => {
		reader.cancel(signal.reason).catch(() => {});
	};
	if (signal.aborted) onAbort();
	else signal.addEventListener("abort", onAbort, { once: true });
	try {
		const chunks: Uint8Array[] = [];
		let length = 0;
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			chunks.push(value);
			length += value.byteLength;
		}
		// A cancelled reader reports `done` rather than rejecting.
		if (signal.aborted) throw signal.reason;
		const bytes = new Uint8Array(length);
		let offset = 0;
		for (const chunk of chunks) {
			bytes.set(chunk, offset);
			offset += chunk.byteLength;
		}
		return bytes;
	} finally {
		signal.removeEventListener("abort", onAbort);
	}
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
