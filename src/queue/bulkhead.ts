import { QueueFullError } from "../core/errors.js"
import type { PartitionConfig } from "../core/types.js"

type Task = () => Promise<void>

export class Bulkhead {
  public readonly name: string
  private readonly concurrency: number
  private readonly maxQueueSize: number
  private running = 0
  private queue: Task[] = []

  constructor(name: string, config: PartitionConfig = {}) {
    this.name = name
    this.concurrency = config.concurrency ?? 5
    this.maxQueueSize = config.maxQueueSize ?? 100
  }

  get queueSize(): number {
    return this.queue.length
  }

  get runningCount(): number {
    return this.running
  }

  get concurrencyLimit(): number {
    return this.concurrency
  }

  get maxQueueSizeLimit(): number {
    return this.maxQueueSize
  }

  canAccept(): boolean {
    return this.queue.length < this.maxQueueSize
  }

  schedule(task: Task): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.canAccept()) {
        reject(new QueueFullError(this.name, this.queue.length, this.maxQueueSize))
        return
      }

      const wrapped = async () => {
        try {
          await task()
          resolve()
        } catch (err) {
          reject(err)
        }
      }

      this.queue.push(wrapped)
      this._drain()
    })
  }

  private _drain(): void {
    while (this.running < this.concurrency && this.queue.length > 0) {
      const task = this.queue.shift()!
      this.running++
      task().finally(() => {
        this.running--
        this._drain()
      })
    }
  }
}

// ---------------------------------------------------------------------------
// Bulkhead registry — one bulkhead per partition
// ---------------------------------------------------------------------------

export interface BulkheadSnapshot {
  name: string
  running: number
  queued: number
  concurrency: number
  maxQueueSize: number
}

export class BulkheadRegistry {
  private readonly bulkheads = new Map<string, Bulkhead>()
  private readonly globalConfig: PartitionConfig
  private readonly partitionConfigs: Record<string, PartitionConfig>

  constructor(
    globalConfig: PartitionConfig = {},
    partitionConfigs: Record<string, PartitionConfig> = {},
  ) {
    this.globalConfig = globalConfig
    this.partitionConfigs = partitionConfigs
  }

  get(partitionName: string): Bulkhead {
    if (!this.bulkheads.has(partitionName)) {
      const partitionConfig = this.partitionConfigs[partitionName] ?? {}
      const merged: PartitionConfig = {
        ...this.globalConfig,
        ...partitionConfig,
      }
      this.bulkheads.set(partitionName, new Bulkhead(partitionName, merged))
    }
    return this.bulkheads.get(partitionName)!
  }

  getAll(): BulkheadSnapshot[] {
    const result: BulkheadSnapshot[] = []
    for (const [, bh] of this.bulkheads) {
      result.push({
        name: bh.name,
        running: bh.runningCount,
        queued: bh.queueSize,
        concurrency: bh.concurrencyLimit,
        maxQueueSize: bh.maxQueueSizeLimit,
      })
    }
    return result
  }
}
