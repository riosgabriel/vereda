export type { MiddlewareFn, NextFn } from "../queue/executor.js";

/**
 * Adds a base set of headers to every request.
 *
 * @example
 * client.use(defaultHeaders({ 'X-Api-Key': 'secret' }));
 */
export function defaultHeaders(headers: Record<string, string>): import("../queue/executor.js").MiddlewareFn {
	return async (options, next) => {
		return next({
			...options,
			headers: { ...headers, ...options.headers },
		});
	};
}

/**
 * Logs request timing to the console (or a provided logger).
 *
 * @example
 * client.use(requestLogger());
 */
export function requestLogger(options?: {
	log?: (msg: string, meta: Record<string, unknown>) => void;
}): import("../queue/executor.js").MiddlewareFn {
	// biome-ignore lint/suspicious/noConsole: console is the intended default sink for this opt-in logger middleware; callers override it via options.log.
	const log = options?.log ?? ((msg, meta) => console.log(msg, meta));

	return async (reqOptions, next) => {
		const start = Date.now();
		try {
			const response = await next(reqOptions);
			log("Request completed", {
				status: response.status,
				durationMs: Date.now() - start,
			});
			return response;
		} catch (err) {
			log("Request failed", {
				error: err instanceof Error ? err.message : String(err),
				durationMs: Date.now() - start,
			});
			throw err;
		}
	};
}
