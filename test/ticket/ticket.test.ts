import { describe, expect, it, vi } from "vitest";
import { CancelledError, NetworkError } from "../../src/core/errors.js";
import { createTicket } from "../../src/ticket/ticket.js";

describe("Ticket", () => {
	it("starts in pending state", () => {
		const { ticket } = createTicket("t1");
		expect(ticket.status.state).toBe("pending");
	});

	it("transitions to queued via controller", () => {
		const { ticket, controller } = createTicket("t1");
		controller.markQueued();
		expect(ticket.status.state).toBe("queued");
	});

	it("transitions to retrying via queued", () => {
		const { ticket, controller } = createTicket("t1");
		controller.markQueued();
		controller.markRetrying(1, 200);
		expect(ticket.status).toEqual({ state: "retrying", attempt: 1 });
	});

	it("resolves toPromise on success", async () => {
		const { ticket, controller } = createTicket<{ id: number }>("t1");
		const fakeResponse = new Response('{"id":1}', { status: 200 });
		setTimeout(
			() =>
				controller.markDone({
					success: true,
					data: { id: 1 },
					raw: fakeResponse,
				}),
			10,
		);
		const result = await ticket.toPromise();
		expect(result.success).toBe(true);
		if (result.success) expect(result.data).toEqual({ id: 1 });
	});

	it("emits done event", async () => {
		const { ticket, controller } = createTicket<string>("t1");
		const fakeResponse = new Response('"hello"', { status: 200 });
		const listener = vi.fn();
		ticket.on("done", listener);
		controller.markDone({ success: true, data: "hello", raw: fakeResponse });
		await Promise.resolve();
		expect(listener).toHaveBeenCalledWith({
			success: true,
			data: "hello",
			raw: fakeResponse,
		});
	});

	it("emits error event on failure", async () => {
		const { ticket, controller } = createTicket<string>("t1");
		const err = new NetworkError("boom");
		const listener = vi.fn();
		ticket.on("error", listener);
		controller.markDone({ success: false, error: err });
		await Promise.resolve();
		expect(listener).toHaveBeenCalledWith(err);
	});

	it("cancels cleanly", () => {
		const { ticket } = createTicket("t1");
		ticket.cancel();
		expect(ticket.status.state).toBe("cancelled");
		expect(ticket.isCancelled).toBe(true);
		expect(ticket.signal.aborted).toBe(true);
	});

	it("subscribe() yields updates as AsyncIterable", async () => {
		const { ticket, controller } = createTicket<string>("t1");
		const fakeResponse = new Response('"ok"', { status: 200 });
		const updates: string[] = [];

		const consume = async () => {
			for await (const update of ticket.subscribe()) {
				updates.push(update.type);
			}
		};

		const p = consume();

		controller.markQueued();
		controller.markRetrying(1, 100);
		controller.markDone({ success: true, data: "ok", raw: fakeResponse });

		await p;

		expect(updates).toEqual(["queued", "retrying", "done"]);
	});

	it("ignores illegal transition (pending -> retrying)", () => {
		const { ticket, controller } = createTicket("t1");
		controller.markRetrying(1, 100); // must go through queued first
		expect(ticket.status.state).toBe("pending");
	});

	it("prevents double resolution", async () => {
		const { ticket, controller } = createTicket<string>("t1");
		const fakeResponse = new Response('"a"', { status: 200 });
		const done = vi.fn();
		ticket.on("done", done);
		controller.markDone({ success: true, data: "a", raw: fakeResponse });
		controller.markDone({ success: true, data: "b", raw: fakeResponse }); // ignored
		const result = await ticket.toPromise();
		expect(result.success).toBe(true);
		if (result.success) expect(result.data).toBe("a");
		expect(done).toHaveBeenCalledTimes(1);
	});

	it("cancel after done is a no-op", () => {
		const { ticket, controller } = createTicket<string>("t1");
		const fakeResponse = new Response('"a"', { status: 200 });
		controller.markDone({ success: true, data: "a", raw: fakeResponse });
		ticket.cancel();
		expect(ticket.status.state).toBe("done");
		expect(ticket.isCancelled).toBe(false);
		expect(ticket.signal.aborted).toBe(false);
	});

	it("cancel() resolves directly with CancelledError", async () => {
		const { ticket, controller } = createTicket("t1");
		const done = vi.fn();
		const error = vi.fn();
		ticket.on("done", done);
		ticket.on("error", error);
		ticket.cancel();
		expect(ticket.status.state).toBe("cancelled");
		expect(ticket.isCancelled).toBe(true);
		const result = await ticket.toPromise();
		expect(result.success).toBe(false);
		if (!result.success) expect(result.error).toBeInstanceOf(CancelledError);
		expect(done).toHaveBeenCalledTimes(1);
		expect(error).toHaveBeenCalledTimes(1);
		// A late markDone is a no-op: cancelled is terminal.
		controller.markDone({ success: true, data: "late", raw: new Response("") });
		expect(ticket.status.state).toBe("cancelled");
	});

	it("off() removes listener so it no longer receives events", async () => {
		const { ticket, controller } = createTicket<string>("t1");
		const fakeResponse = new Response('"ok"', { status: 200 });
		const listener = vi.fn();
		ticket.on("done", listener);
		ticket.off("done", listener);
		controller.markDone({ success: true, data: "ok", raw: fakeResponse });
		await Promise.resolve();
		expect(listener).not.toHaveBeenCalled();
	});

	it("ticket._markDone is not accessible from outside", () => {
		// This test verifies the API contract: _mark methods are private.
		// TypeScript should reject ticket._markDone() at compile time.
		// At runtime, accessing a private TS field via bracket notation still
		// works, but the method no longer exists on the public interface.
		const { ticket } = createTicket("t1");
		expect((ticket as any)._markDone).toBeUndefined();
		expect((ticket as any)._markQueued).toBeUndefined();
		expect((ticket as any)._markRetrying).toBeUndefined();
	});
});
