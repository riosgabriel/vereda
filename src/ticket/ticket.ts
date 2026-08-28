import { EventEmitter } from "node:events"
import type { Result } from "../core/types.js"
import type { AppError } from "../core/errors.js"

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
    this._cancelled = true
    this._abortController.abort()
    this._status = { state: "cancelled" }
    const update: TicketUpdate = { type: "cancelled" }
    this.emitter.emit("update", update)
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
    this._status = { state: "queued" }
    this.emitter.emit("update", { type: "queued" } as TicketUpdate)
  }

  _markRetrying(attempt: number, delayMs: number): void {
    this._status = { state: "retrying", attempt }
    this.emitter.emit("update", { type: "retrying", attempt, delayMs } as TicketUpdate)
  }

  _markDone(result: Result<T>): void {
    this._status = { state: "done", result }
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
