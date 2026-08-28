import { EventEmitter } from "node:events"
import type { Result } from "../core/types.js"
import type { AppError } from "../core/errors.js"
import { CancelledError } from "../core/errors.js"

export type TicketStatus =
  | { state: "pending" }
  | { state: "queued" }
  | { state: "retrying"; attempt: number }
  | { state: "done"; result: Result<unknown> }
  | { state: "cancelled" }

export type TicketUpdate =
  | { type: "queued" }
  | { type: "retrying"; attempt: number; delayMs: number }
  | { type: "done"; result: Result<unknown> }
  | { type: "cancelled" }

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
}

export class Ticket<T> {
  public readonly id: string

  private readonly emitter = new EventEmitter()
  private _status: TicketStatus = { state: "pending" }
  private _cancelled = false
  private _abortController = new AbortController()
  private _resolve!: (result: Result<T>) => void
  private _promise: Promise<Result<T>>

  constructor(id: string) {
    this.id = id
    this._promise = new Promise<Result<T>>((resolve) => {
      this._resolve = resolve
    })
    // Prevent Node from throwing on unhandled "error" events
    this.emitter.on("error", () => {})
  }

  get status(): TicketStatus {
    return this._status
  }

  /** Validate and apply a state transition. Returns false (and leaves the
   *  current state untouched) when `next` is not reachable from the current
   *  state, so illegal transitions are ignored rather than corrupting state. */
  private applyTransition(next: TicketStatus): boolean {
    if (!ALLOWED_TRANSITIONS[this._status.state].includes(next.state)) {
      return false
    }
    this._status = next
    return true
  }

  get signal(): AbortSignal {
    return this._abortController.signal
  }

  on(event: "done", listener: (result: Result<T>) => void): this
  on(event: "error", listener: (error: AppError) => void): this
  on(event: "update", listener: (update: TicketUpdate) => void): this
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: string, listener: (...args: any[]) => void): this {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.emitter.on(event, listener as (...args: any[]) => void)
    return this
  }

  off(event: string, listener: (...args: unknown[]) => void): this {
    this.emitter.off(event, listener)
    return this
  }

  cancel(): void {
    if (this._cancelled) return
    // `cancelled` is terminal — if the ticket already resolved, this is a no-op.
    if (!this.applyTransition({ state: "cancelled" })) return
    this._cancelled = true
    this._abortController.abort()
    const result: Result<T> = { success: false, error: new CancelledError() }
    this.emitter.emit("update", { type: "cancelled" } as TicketUpdate)
    this.emitter.emit("done", result)
    this.emitter.emit("error", result.error)
    this._resolve(result)
  }

  toPromise(): Promise<Result<T>> {
    return this._promise
  }

  async *subscribe(): AsyncGenerator<TicketUpdate> {
    // Already terminal — yield synthetic update and return
    const current = this._status
    if (current.state === "done") {
      yield { type: "done", result: current.result }
      return
    }
    if (current.state === "cancelled") {
      yield { type: "cancelled" }
      return
    }

    const updates: TicketUpdate[] = []
    let notify: (() => void) | null = null
    let isDone = false

    const onUpdate = (update: TicketUpdate) => {
      updates.push(update)
      notify?.()
      notify = null
      if (update.type === "done" || update.type === "cancelled") {
        isDone = true
      }
    }

    this.emitter.on("update", onUpdate)

    try {
      while (!isDone || updates.length > 0) {
        if (updates.length > 0) {
          yield updates.shift()!
        } else {
          await new Promise<void>((r) => {
            notify = r
          })
        }
      }
    } finally {
      this.emitter.off("update", onUpdate)
    }
  }

  _markQueued(): void {
    if (!this.applyTransition({ state: "queued" })) return
    this.emitter.emit("update", { type: "queued" } as TicketUpdate)
  }

  _markRetrying(attempt: number, delayMs: number): void {
    if (!this.applyTransition({ state: "retrying", attempt })) return
    this.emitter.emit("update", { type: "retrying", attempt, delayMs } as TicketUpdate)
  }

  _markDone(result: Result<T>): void {
    if (!this.applyTransition({ state: "done", result })) return
    this.emitter.emit("update", { type: "done", result } as TicketUpdate)
    this.emitter.emit("done", result)
    if (result.success === false) {
      this.emitter.emit("error", result.error)
    }
    this._resolve(result)
  }

  get isCancelled(): boolean {
    return this._cancelled
  }
}
