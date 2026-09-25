import { redactUrl } from "../core/redact.ts";

export type { MiddlewareFn, NextFn, RequestContext } from "../queue/executor.ts";

/**
 * Adds a base set of headers to every request. Only sets a header the
 * request doesn't already have — comparison is case-insensitive, so a
 * request-level `authorization` header wins over a default `Authorization`.
 *
 * @example
 * client.use(defaultHeaders({ 'X-Api-Key': 'secret' }));
 */
export function defaultHeaders(headers: HeadersInit): import("../queue/executor.ts").MiddlewareFn {
	return async (ctx, next) => {
		for (const [key, value] of new Headers(headers)) {
			if (!ctx.headers.has(key)) {
				ctx.headers.set(key, value);
			}
		}
		return next(ctx);
	};
}

/**
 * Logs request timing to the console (or a provided logger). Logged URLs are
 * redacted like the client's own (`redactUrl`): query values and userinfo
 * credentials are replaced with `[redacted]`. Middleware can't see the
 * client's `redactQuery` setting, so pass `redactQuery: false` here too to
 * log raw URLs.
 *
 * @example
 * client.use(requestLogger());
 */
export function requestLogger(options?: {
	log?: (msg: string, meta: Record<string, unknown>) => void;
	/** @default true */
	redactQuery?: boolean;
}): import("../queue/executor.ts").MiddlewareFn {
	// biome-ignore lint/suspicious/noConsole: console is the intended default sink for this opt-in logger middleware; callers override it via options.log.
	const log = options?.log ?? ((msg, meta) => console.log(msg, meta));

	const shownUrl = options?.redactQuery === false ? (url: string) => url : redactUrl;

	return async (ctx, next) => {
		const start = Date.now();
		try {
			const response = await next(ctx);
			log("Request completed", {
				url: shownUrl(ctx.url),
				status: response.status,
				durationMs: Date.now() - start,
			});
			return response;
		} catch (err) {
			log("Request failed", {
				url: shownUrl(ctx.url),
				error: err instanceof Error ? err.message : String(err),
				durationMs: Date.now() - start,
			});
			throw err;
		}
	};
}
