import { describe, it, expect, vi } from "vitest";
import { Ticket } from "../../src/ticket/ticket.js";
import { NetworkError, CancelledError } from "../../src/core/errors.js";

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

  it("transitions to retrying via queued", () => {
    const t = new Ticket("t1");
    t._markQueued();
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

  it("ignores illegal transition (pending -> retrying)", () => {
    const t = new Ticket("t1");
    t._markRetrying(1, 100); // must go through queued first
    expect(t.status.state).toBe("pending");
  });

  it("prevents double resolution", async () => {
    const t = new Ticket<string>("t1");
    const fakeResponse = new Response('"a"', { status: 200 });
    const done = vi.fn();
    t.on("done", done);
    t._markDone({ success: true, data: "a", raw: fakeResponse });
    t._markDone({ success: true, data: "b", raw: fakeResponse }); // ignored
    const result = await t.toPromise();
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toBe("a");
    expect(done).toHaveBeenCalledTimes(1);
  });

  it("cancel after done is a no-op", () => {
    const t = new Ticket<string>("t1");
    const fakeResponse = new Response('"a"', { status: 200 });
    t._markDone({ success: true, data: "a", raw: fakeResponse });
    t.cancel();
    expect(t.status.state).toBe("done");
    expect(t.isCancelled).toBe(false);
    expect(t.signal.aborted).toBe(false);
  });

  it("cancel() resolves directly with CancelledError", async () => {
    const t = new Ticket("t1");
    const done = vi.fn();
    const error = vi.fn();
    t.on("done", done);
    t.on("error", error);
    t.cancel();
    expect(t.status.state).toBe("cancelled");
    expect(t.isCancelled).toBe(true);
    const result = await t.toPromise();
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toBeInstanceOf(CancelledError);
    expect(done).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledTimes(1);
    // A late _markDone is a no-op: cancelled is terminal.
    t._markDone({ success: true, data: "late", raw: new Response("") });
    expect(t.status.state).toBe("cancelled");
  });
});
