import { EventEmitter } from "node:events";
import type { AppError } from "../core/errors.js";
import { CancelledError } from "../core/errors.js";
import type { Result } from "../core/types.js";

export type TicketStatus =
  | { state: "pending" }
  | { state: "queued" }
  | { state: "retrying"; attempt: number }
  | { state: "done"; result: Result<unknown> }
  | { state: "cancelled" };

export type TicketUpdate =
  | { type: "queued" }
  | { type: "retrying"; attempt: number; delayMs: number }
  | { type: "done"; result: Result<unknown> }
  | { type: "cancelled" };

// Allowed transitions between ticket states. `done` and `cancelled` are both
// terminal: `cancel()` resolves the ticket directly with a CancelledError
// result, so a cancelled ticket is never transitioned to `done` by the retry
// loop (its `_markDone` becomes a no-op). The `retrying -> retrying` self-loop
// permits re-entering `retrying` with a new attempt number (a fresh status
// object is assigned, not mutated in place). `pending -> done` is the
// first-attempt success path: client.ts calls `_markDone` directly from
// `pending` when the initial request succeeds, so it is an intentional
// shortcut, not a gap in the lifecycle.
const ALLOWED_TRANSITIONS: Record<TicketStatus["state"], TicketStatus["state"][]> = {
  pending: ["queued", "done", "cancelled"],
  queued: ["retrying", "done", "cancelled"],
  retrying: ["retrying", "done", "cancelled"],
  cancelled: [],
  done: [],
};

// ---------------------------------------------------------------------------
// TicketController — the only way to mutate a ticket's lifecycle
// ---------------------------------------------------------------------------

export interface TicketController<T> {
  markQueued(): void;
  markRetrying(attempt: number, delayMs: number): void;
  markDone(result: Result<T>): void;
  /** @internal — abort the signal without resolving the ticket. Used by the
   *  deadline timer so the retry loop can resolve with DeadlineExceededError
   *  instead of CancelledError. */
  abortSignal(): void;
}

// ---------------------------------------------------------------------------
// Ticket
// ---------------------------------------------------------------------------

export class Ticket<T> {
  public readonly id: string;

  private readonly emitter = new EventEmitter();
  private _status: TicketStatus = { state: "pending" };
  private _cancelled = false;
  private _abortController = new AbortController();
  private _resolve!: (result: Result<T>) => void;
  private _promise: Promise<Result<T>>;

  /** @internal — use `createTicket()` to obtain a ticket and its controller. */
  constructor(id: string) {
    this.id = id;
    this._promise = new Promise<Result<T>>((resolve) => {
      this._resolve = resolve;
    });
    // Prevent Node from throwing on unhandled "error" events
    this.emitter.on("error", () => {});
  }

  get status(): TicketStatus {
    return this._status;
  }

  /** Validate and apply a state transition. Returns false (and leaves the
   *  current state untouched) when `next` is not reachable from the current
   *  state, so illegal transitions are ignored rather than corrupting state. */
  private applyTransition(next: TicketStatus): boolean {
    if (!ALLOWED_TRANSITIONS[this._status.state].includes(next.state)) {
      return false;
    }
    this._status = next;
    return true;
  }

  get signal(): AbortSignal {
    return this._abortController.signal;
  }

  // -- Event subscriptions --------------------------------------------------

  on(event: "done", listener: (result: Result<T>) => void): this;
  on(event: "error", listener: (error: AppError) => void): this;
  on(event: "update", listener: (update: TicketUpdate) => void): this;
  on(event: string, listener: (...args: any[]) => void): this {
    this.emitter.on(event, listener as (...args: any[]) => void);
    return this;
  }

  off(event: "done", listener: (result: Result<T>) => void): this;
  off(event: "error", listener: (error: AppError) => void): this;
  off(event: "update", listener: (update: TicketUpdate) => void): this;
  off(event: string, listener: (...args: any[]) => void): this {
    this.emitter.off(event, listener as (...args: any[]) => void);
    return this;
  }

  // -- Public API ------------------------------------------------------------

  cancel(): void {
    if (this._cancelled) return;
    // `cancelled` is terminal — if the ticket already resolved, this is a no-op.
    if (!this.applyTransition({ state: "cancelled" })) return;
    this._cancelled = true;
    this._abortController.abort();
    const result: Result<T> = { success: false, error: new CancelledError() };
    this.emitter.emit("update", { type: "cancelled" } as TicketUpdate);
    this.emitter.emit("done", result);
    this.emitter.emit("error", result.error);
    this._resolve(result);
  }

  toPromise(): Promise<Result<T>> {
    return this._promise;
  }

  async *subscribe(): AsyncGenerator<TicketUpdate> {
    // Already terminal — yield synthetic update and return
    const current = this._status;
    if (current.state === "done") {
      yield { type: "done", result: current.result };
      return;
    }
    if (current.state === "cancelled") {
      yield { type: "cancelled" };
      return;
    }

    const updates: TicketUpdate[] = [];
    let notify: (() => void) | null = null;
    let isDone = false;

    const onUpdate = (update: TicketUpdate) => {
      updates.push(update);
      notify?.();
      notify = null;
      if (update.type === "done" || update.type === "cancelled") {
        isDone = true;
      }
    };

    this.emitter.on("update", onUpdate);

    try {
      while (!isDone || updates.length > 0) {
        if (updates.length > 0) {
          yield updates.shift()!;
        } else {
          await new Promise<void>((r) => {
            notify = r;
          });
        }
      }
    } finally {
      this.emitter.off("update", onUpdate);
    }
  }

  get isCancelled(): boolean {
    return this._cancelled;
  }

  // -- Internal mutators (private, accessed via TicketController) ------------

  private markQueued(): void {
    if (!this.applyTransition({ state: "queued" })) return;
    this.emitter.emit("update", { type: "queued" } as TicketUpdate);
  }

  private markRetrying(attempt: number, delayMs: number): void {
    if (!this.applyTransition({ state: "retrying", attempt })) return;
    this.emitter.emit("update", { type: "retrying", attempt, delayMs } as TicketUpdate);
  }

  private markDone(result: Result<T>): void {
    if (!this.applyTransition({ state: "done", result })) return;
    this.emitter.emit("update", { type: "done", result } as TicketUpdate);
    this.emitter.emit("done", result);
    if (result.success === false) {
      this.emitter.emit("error", result.error);
    }
    this._resolve(result);
  }
}

// ---------------------------------------------------------------------------
// Factory — the only public way to get a ticket and its controller
// ---------------------------------------------------------------------------

export function createTicket<T>(id: string): {
  ticket: Ticket<T>;
  controller: TicketController<T>;
} {
  const ticket = new Ticket<T>(id);

  // Bind the private methods to the ticket instance and expose them
  // through the controller interface.
  const controller: TicketController<T> = {
    // Bracket notation accesses private methods — the type boundary prevents
    // external callers from reaching these, while the controller provides
    // a clean compile-time API for internal use.
    markQueued: () => ticket["markQueued"](),
    markRetrying: (attempt, delayMs) => ticket["markRetrying"](attempt, delayMs),
    markDone: (result) => ticket["markDone"](result),
    abortSignal: () => ticket["_abortController"].abort(),
  };

  return { ticket, controller };
}
