import { describe, it, expect, vi } from "vitest";
import { Ticket } from "../../src/ticket/ticket.js";

describe("Ticket", () => {
  it("starts in pending state", () => {
    const t = new Ticket("t1");
    expect(t.status.state).toBe("pending");
  });

  it("transitions to queued", () => {
    const t = new Ticket("t1");
    t._markQueued();
    expect(t.status.state).toBe("queued");
  });

  it("transitions to retrying", () => {
    const t = new Ticket("t1");
    t._markRetrying(1, 200);
    expect(t.status).toEqual({ state: "retrying", attempt: 1 });
  });

  it("resolves toPromise on success", async () => {
    const t = new Ticket<{ id: number }>("t1");
    const fakeResponse = new Response('{"id":1}', { status: 200 });
    setTimeout(() => t._markDone({ success: true, data: { id: 1 }, raw: fakeResponse }), 10);
    const result = await t.toPromise();
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toEqual({ id: 1 });
  });

  it("emits done event", async () => {
    const t = new Ticket<string>("t1");
    const fakeResponse = new Response('"hello"', { status: 200 });
    const listener = vi.fn();
    t.on("done", listener);
    t._markDone({ success: true, data: "hello", raw: fakeResponse });
    await Promise.resolve();
    expect(listener).toHaveBeenCalledWith({ success: true, data: "hello", raw: fakeResponse });
  });

  it("emits error event on failure", async () => {
    const { NetworkError } = await import("../../src/core/errors.js");
    const t = new Ticket<string>("t1");
    const err = new NetworkError("boom");
    const listener = vi.fn();
    t.on("error", listener);
    t._markDone({ success: false, error: err });
    await Promise.resolve();
    expect(listener).toHaveBeenCalledWith(err);
  });

  it("cancels cleanly", () => {
    const t = new Ticket("t1");
    t.cancel();
    expect(t.status.state).toBe("cancelled");
    expect(t.isCancelled).toBe(true);
    expect(t.signal.aborted).toBe(true);
  });

  it("subscribe() yields updates as AsyncIterable", async () => {
    const t = new Ticket<string>("t1");
    const fakeResponse = new Response('"ok"', { status: 200 });
    const updates: string[] = [];

    const consume = async () => {
      for await (const update of t.subscribe()) {
        updates.push(update.type);
      }
    };

    const p = consume();

    t._markQueued();
    t._markRetrying(1, 100);
    t._markDone({ success: true, data: "ok", raw: fakeResponse });

    await p;

    expect(updates).toEqual(["queued", "retrying", "done"]);
  });
});
