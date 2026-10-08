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

// biome-ignore lint/suspicious/noExplicitAny: listeners are typed by the public on()/off() overloads.
type Listener = (...args: any[]) => void;

/** Minimal runtime-neutral replacement for `node:events`' EventEmitter,
 *  keeping the semantics callers relied on: a listener added twice runs
 *  twice, `off` removes its most recently added registration, and an emit
 *  iterates a snapshot (listeners added or removed mid-emit don't affect it).
 *  `emit` isolates listeners: every one runs even if an earlier one throws,
 *  and no throw escapes to the caller (B2/B3). There is no special `"error"`
 *  event: an unheard one is simply dropped. */
export class Emitter {
	private readonly listeners = new Map<string, Listener[]>();

	on(event: string, listener: Listener): void {
		const list = this.listeners.get(event);
		if (list) list.push(listener);
		else this.listeners.set(event, [listener]);
	}

	off(event: string, listener: Listener): void {
		const list = this.listeners.get(event);
		if (!list) return;
		const index = list.lastIndexOf(listener);
		if (index === -1) return;
		list.splice(index, 1);
		if (list.length === 0) this.listeners.delete(event);
	}

	emit(event: string, ...args: unknown[]): void {
		const list = this.listeners.get(event);
		if (!list) return;
		for (const listener of [...list]) {
			try {
				listener(...args);
			} catch (err) {
				reportCallbackError(err);
			}
		}
	}
}
