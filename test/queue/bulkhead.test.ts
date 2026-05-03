import { describe, it, expect, vi } from "vitest";
import { Bulkhead, BulkheadRegistry } from "../../src/queue/bulkhead.js";

describe("Bulkhead", () => {
  it("runs tasks up to concurrency limit", async () => {
    const bh = new Bulkhead("test", { concurrency: 2 });
    const running: number[] = [];
    let maxConcurrent = 0;

    const makeTask = (id: number, delay: number) => async () => {
      running.push(id);
      maxConcurrent = Math.max(maxConcurrent, running.length);
      await new Promise((r) => setTimeout(r, delay));
      running.splice(running.indexOf(id), 1);
    };

    await Promise.all([
      bh.schedule(makeTask(1, 30)),
      bh.schedule(makeTask(2, 30)),
      bh.schedule(makeTask(3, 10)),
    ]);

    expect(maxConcurrent).toBeLessThanOrEqual(2);
  });

  it("rejects tasks when queue is full", async () => {
    const bh = new Bulkhead("test", { concurrency: 1, maxQueueSize: 1 });
    const slow = () => new Promise<void>((r) => setTimeout(r, 100));

    // First fills the runner
    bh.schedule(slow);
    // Second fills the queue
    bh.schedule(slow);
    // Third should be rejected
    await expect(bh.schedule(slow)).rejects.toThrow("full");
  });

  it("reports queue and running counts", async () => {
    const bh = new Bulkhead("test", { concurrency: 1 });
    const slow = () => new Promise<void>((r) => setTimeout(r, 50));

    const p1 = bh.schedule(slow);
    bh.schedule(slow);

    expect(bh.runningCount).toBe(1);
    expect(bh.queueSize).toBe(1);

    await p1;
  });
});

describe("BulkheadRegistry", () => {
  it("creates separate bulkheads per partition", () => {
    const registry = new BulkheadRegistry({ concurrency: 5 });
    const a = registry.get("payments");
    const b = registry.get("notifications");
    expect(a).not.toBe(b);
  });

  it("returns the same bulkhead for the same partition", () => {
    const registry = new BulkheadRegistry();
    expect(registry.get("payments")).toBe(registry.get("payments"));
  });

  it("applies partition-specific config", () => {
    const registry = new BulkheadRegistry(
      { concurrency: 10 },
      { payments: { concurrency: 2 } }
    );
    const payments = registry.get("payments");
    expect((payments as unknown as { concurrency: number }).concurrency).toBe(2);
  });
});
