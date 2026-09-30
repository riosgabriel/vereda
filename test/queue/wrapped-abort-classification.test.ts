import { describe, expect, it } from "vitest";
import { HttpClient } from "../../src/core/client.ts";

/** Never settles until the attempt's signal aborts. */
const hang: typeof globalThis.fetch = (_input, init) =>
	new Promise((_resolve, reject) => {
		init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
	});

function recordTerminalEvents(client: HttpClient): string[] {
	const events: string[] = [];
	for (const e of ["success", "failure", "cancelled"] as const) client.on(e, () => events.push(e));
	return events;
}

describe("wrapped abort errors are classified by the aborting signal (B14)", () => {
	it("middleware that wraps the abort error during an attemptMs timeout still yields a timeout error", async () => {
		const client = HttpClient.create({
			timeout: { attemptMs: 30 },
			retry: { maxRetries: 0 },
			fetch: hang,
		});
		client.use(async (ctx, next) => {
			try {
				return await next(ctx);
			} catch (e) {
				throw new Error("wrapped", { cause: e });
			}
		});
		const events = recordTerminalEvents(client);

		const result = await client.get("http://svc.test/slow").toPromise();

		expect(result.success === false && result.error.kind).toBe("timeout");
		expect(events).toEqual(["failure"]);
	});

	it("a genuine network error thrown by middleware is still a network error", async () => {
		const client = HttpClient.create({
			timeout: { attemptMs: 1_000 },
			retry: { maxRetries: 0 },
			fetch: async () => new Response("{}"),
		});
		client.use(async () => {
			throw new Error("connection reset");
		});
		const events = recordTerminalEvents(client);

		const result = await client.get("http://svc.test/x").toPromise();

		expect(result.success === false && result.error.kind).toBe("network");
		expect(events).toEqual(["failure"]);
	});

	it("user cancellation still wins over a wrapped abort error", async () => {
		const client = HttpClient.create({
			timeout: { attemptMs: 1_000 },
			retry: { maxRetries: 0 },
			fetch: hang,
		});
		client.use(async (ctx, next) => {
			try {
				return await next(ctx);
			} catch (e) {
				throw new Error("wrapped", { cause: e });
			}
		});
		const events = recordTerminalEvents(client);

		const ticket = client.get("http://svc.test/slow");
		setTimeout(() => ticket.cancel(), 20);
		const result = await ticket.toPromise();
		await new Promise((resolve) => setTimeout(resolve, 10)); // let the terminal event land

		expect(result.success).toBe(false);
		expect(result.success === false && result.error.kind).not.toBe("network");
		expect(events).toEqual(["cancelled"]);
	});
});
