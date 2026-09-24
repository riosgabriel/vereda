import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpClient } from "../../src/core/client.js";
import type { MetricsSink } from "../../src/core/metrics.js";
import { createTicket } from "../../src/ticket/ticket.js";

// reportCallbackError rethrows on a microtask so the error reaches
// uncaughtException; capture it here instead of crashing the test run.
let reported: unknown[];
beforeEach(() => {
	reported = [];
	vi.stubGlobal("queueMicrotask", (fn: () => void) => {
		try {
			fn();
		} catch (err) {
			reported.push(err);
		}
	});
});
afterEach(() => {
	vi.unstubAllGlobals();
});

const ok: typeof globalThis.fetch = async () => new Response("{}", { status: 200 });
const boom = new Error("listener bug");
const thrower = () => {
	throw boom;
};

describe("Ticket listener isolation (B2)", () => {
	it("a throwing 'done' listener does not stop the ticket from resolving", async () => {
		const client = HttpClient.create({ timeout: { attemptMs: 1_000 }, fetch: ok });
		const ticket = client.get("http://svc/");
		ticket.on("done", thrower);

		const result = await ticket.toPromise();
		expect(result.success).toBe(true);
		expect(reported).toEqual([boom]);
	});

	it("a throwing listener does not stop cancel() from resolving", async () => {
		const { ticket } = createTicket("t1");
		ticket.on("update", thrower);
		ticket.cancel();

		const result = await ticket.toPromise();
		expect(result.success === false && result.error.kind).toBe("cancelled");
		expect(reported).toEqual([boom]);
	});

	it("later listeners still run after an earlier one throws", async () => {
		const { ticket, controller } = createTicket("t2");
		const seen: string[] = [];
		ticket.on("done", thrower);
		ticket.on("done", () => seen.push("second"));
		controller.markDone({ success: true, data: undefined, raw: new Response() });

		await ticket.toPromise();
		expect(seen).toEqual(["second"]);
	});
});

describe("Client listener and metrics isolation (B3)", () => {
	it("a throwing 'success' listener does not turn a success into a failure", async () => {
		const client = HttpClient.create({ timeout: { attemptMs: 1_000 }, fetch: ok });
		const failures: unknown[] = [];
		client.on("success", thrower);
		client.on("failure", (e) => failures.push(e));

		const result = await client.get("http://svc/").toPromise();
		expect(result.success).toBe(true);
		expect(failures).toEqual([]);
		expect(reported).toEqual([boom]);
	});

	it("a throwing metrics sink does not turn a success into a failure", async () => {
		const metrics: MetricsSink = { counter: thrower, histogram: thrower, gauge: thrower };
		const client = HttpClient.create({ timeout: { attemptMs: 1_000 }, fetch: ok, metrics });

		const result = await client.get("http://svc/").toPromise();
		expect(result.success).toBe(true);
		expect(reported.length).toBeGreaterThan(0);
	});

	it("a throwing listener on the retry path does not break the retry loop", async () => {
		let calls = 0;
		const fetch: typeof globalThis.fetch = async () => new Response("{}", { status: ++calls === 1 ? 503 : 200 });
		const client = HttpClient.create({
			timeout: { attemptMs: 1_000 },
			retry: { backoff: { baseDelayMs: 1, jitter: false } },
			fetch,
		});
		client.on("retry", thrower);
		client.on("success", thrower);

		const result = await client.get("http://svc/").toPromise();
		expect(result.success).toBe(true);
		expect(calls).toBe(2);
		expect(reported).toEqual([boom, boom]);
	});
});
