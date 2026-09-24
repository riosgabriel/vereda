import { describe, expect, it } from "vitest";
import { HttpClient } from "../../src/core/client.js";
import type { CloseOptions } from "../../src/core/types.js";

const slowOk: typeof globalThis.fetch = () =>
	new Promise((resolve) => setTimeout(() => resolve(new Response("{}", { status: 200 })), 50));

describe("close() (B8)", () => {
	it("rejects invalid drain options without closing the client", async () => {
		const client = HttpClient.create({ timeout: { attemptMs: 1_000 }, fetch: slowOk });
		const ticket = client.get("http://svc.test/");

		await expect(client.close({ drain: true, timeoutMs: 0 } as CloseOptions)).rejects.toThrow(/positive timeoutMs/);
		// Still open: new requests are accepted.
		expect(() => client.get("http://svc.test/")).not.toThrow();

		await client.close({ drain: true, timeoutMs: 1_000 });
		const result = await ticket.toPromise();
		expect(result.success).toBe(true); // drained, not cancelled
	});

	it("a second close() during a drain waits for the same shutdown", async () => {
		const client = HttpClient.create({ timeout: { attemptMs: 1_000 }, fetch: slowOk });
		const ticket = client.get("http://svc.test/");

		const first = client.close({ drain: true, timeoutMs: 1_000 });
		await client.close();
		expect(ticket.status.state).toBe("done");
		const result = await ticket.toPromise();
		expect(result.success).toBe(true);
		await first;
	});
});
