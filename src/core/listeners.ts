import type { EventEmitter } from "node:events";

/** Surface an error thrown by user code (an event listener or a metrics sink)
 *  without letting it unwind through vereda's internals. It is rethrown on a
 *  fresh microtask, so it reaches `process.on("uncaughtException")` exactly
 *  like a throwing listener on any other emitter would — the same contract as
 *  `node:diagnostics_channel` subscribers. Swallowing it would hide the bug;
 *  letting it propagate synchronously would abort whatever state transition
 *  was in progress (a ticket that never resolves, B2; a success rewritten
 *  as a failure, B3). */
export function reportCallbackError(err: unknown): void {
	queueMicrotask(() => {
		throw err;
	});
}

/** `emitter.emit()` with per-listener isolation: every listener runs even if
 *  an earlier one throws, and no throw escapes to the caller. */
export function emitIsolated(emitter: EventEmitter, event: string, ...args: unknown[]): void {
	// rawListeners, not listeners: calling a `once` wrapper also unregisters it.
	for (const listener of emitter.rawListeners(event)) {
		try {
			listener(...args);
		} catch (err) {
			reportCallbackError(err);
		}
	}
}
