import { describe, expect, it } from "vitest";
import { HttpClient } from "../../src/core/client.ts";
import { CancelledError, DeadlineExceededError, TimeoutError } from "../../src/core/errors.ts";

/**
 * #181: an attempt ends when its signal aborts, even if the transport ignores
 * that signal (a custom `fetch` that drops `init.signal`, or middleware that
 * swaps `ctx.signal`). Before, `await fetch` never returned, so `cancel()`,
 * `attemptMs` and `totalMs` never ended the attempt and the ticket's terminal
 * lifecycle event never fired.
 */

/** Never settles and never looks at `init.signal`. */
const deafFetch = (() => new Promise<Response>(() => {})) as typeof globalThis.fetch;

function trackEvents(client: HttpClient) {
	const events: string[] = [];
	for (const name of ["request", "retry", "success", "failure", "cancelled"] as const) {
		client.on(name, () => events.push(name));
	}
	return events;
}

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

describe("a transport that ignores the abort signal (#181)", () => {
	it("cancel() ends the attempt and fires exactly one cancelled event", async () => {
		const client = HttpClient.create({ timeout: { attemptMs: 60_000 }, fetch: deafFetch });
		const events = trackEvents(client);

		const ticket = client.get("https://api.example.com/slow");
		await tick(5);
		ticket.cancel();
		const result = await ticket.toPromise();
		await tick(5);

		expect(!result.success && result.error).toBeInstanceOf(CancelledError);
		expect(events).toEqual(["request", "cancelled"]);
	});

	it("attemptMs times the attempt out", async () => {
		const client = HttpClient.create({
			timeout: { attemptMs: 30 },
			retry: { maxRetries: 0 },
			fetch: deafFetch,
		});
		const events = trackEvents(client);

		const start = Date.now();
		const result = await client.get("https://api.example.com/slow").toPromise();

		expect(Date.now() - start).toBeLessThan(1_000);
		expect(!result.success && result.error).toBeInstanceOf(TimeoutError);
		expect(events).toEqual(["request", "failure"]);
	});

	it("totalMs fails the ticket with DeadlineExceededError", async () => {
		const client = HttpClient.create({
			timeout: { attemptMs: 60_000, totalMs: 30 },
			fetch: deafFetch,
		});
		const events = trackEvents(client);

		const result = await client.get("https://api.example.com/slow").toPromise();

		expect(!result.success && result.error).toBeInstanceOf(DeadlineExceededError);
		expect(events).toEqual(["request", "failure"]);
	});

	it("cancel() also ends a retry attempt", async () => {
		let calls = 0;
		const fetch = (async () => {
			calls++;
			if (calls === 1) return new Response(null, { status: 503 });
			return new Promise<Response>(() => {});
		}) as typeof globalThis.fetch;
		const client = HttpClient.create({
			timeout: { attemptMs: 60_000 },
			retry: { backoff: { baseDelayMs: 1, jitter: false } },
			fetch,
		});
		const events = trackEvents(client);

		const ticket = client.get("https://api.example.com/flaky");
		while (calls < 2) await tick(1);
		ticket.cancel();
		await ticket.toPromise();
		await tick(5);

		expect(events).toEqual(["request", "retry", "cancelled"]);
	});

	it("cancels the body of a response that arrives after the attempt was abandoned", async () => {
		let deliver!: (response: Response) => void;
		let bodyCancelled = false;
		const fetch = (() => new Promise<Response>((resolve) => (deliver = resolve))) as typeof globalThis.fetch;
		const client = HttpClient.create({ timeout: { attemptMs: 60_000 }, fetch });

		const ticket = client.get("https://api.example.com/late");
		await tick(5);
		ticket.cancel();
		await ticket.toPromise();

		const body = new ReadableStream({
			cancel() {
				bodyCancelled = true;
			},
		});
		deliver(new Response(body, { status: 200 }));
		await tick(5);

		expect(bodyCancelled).toBe(true);
	});

	it("doesn't surface a late rejection as unhandled", async () => {
		let fail!: (err: Error) => void;
		const fetch = (() => new Promise<Response>((_, reject) => (fail = reject))) as typeof globalThis.fetch;
		const client = HttpClient.create({ timeout: { attemptMs: 60_000 }, fetch });
		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown) => unhandled.push(reason);
		process.on("unhandledRejection", onUnhandled);

		try {
			const ticket = client.get("https://api.example.com/late");
			await tick(5);
			ticket.cancel();
			await ticket.toPromise();
			fail(new TypeError("socket hang up"));
			await tick(20);

			expect(unhandled).toEqual([]);
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
	});
});
