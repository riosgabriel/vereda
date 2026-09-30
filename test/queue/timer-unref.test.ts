import { createServer, type Server } from "node:http";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { HttpClient } from "../../src/core/client.ts";

/**
 * docs/operations.md promises every internal timer is unref()'d so a Vereda
 * client never keeps the event loop alive on its own (B17). Distinct delays
 * per timer kind let the spy tell them apart.
 */
const ATTEMPT_MS = 4_001;
const TOTAL_MS = 4_002;
const BACKOFF_MS = 7;

describe("internal timers are unref'd (B17)", () => {
	let server: Server;
	let url: string;
	let hits = 0;

	beforeAll(async () => {
		server = createServer((_req, res) => {
			hits++;
			res.writeHead(hits === 1 ? 503 : 200);
			res.end("{}");
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const addr = server.address();
		if (addr && typeof addr === "object") url = `http://127.0.0.1:${addr.port}`;
	});

	afterAll(async () => {
		await new Promise((resolve) => server.close(resolve));
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("unrefs the totalMs, attemptMs, and backoff timers", async () => {
		hits = 0;
		const unrefByDelay = new Map<number, ReturnType<typeof vi.fn>[]>();
		const realSetTimeout = globalThis.setTimeout;
		vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, ms?: number, ...args: unknown[]) => {
			const handle = realSetTimeout(fn, ms, ...args);
			const spy = vi.spyOn(handle as unknown as { unref(): unknown }, "unref");
			unrefByDelay.set(ms ?? 0, [...(unrefByDelay.get(ms ?? 0) ?? []), spy]);
			return handle;
		}) as unknown as typeof setTimeout);

		const client = HttpClient.create({
			baseUrl: url,
			timeout: { attemptMs: ATTEMPT_MS, totalMs: TOTAL_MS },
			retry: { maxRetries: 1, backoff: { baseDelayMs: BACKOFF_MS, jitter: false } },
		});
		const result = await client.get("/").toPromise();
		await client.close();

		expect(result.success).toBe(true);
		expect(hits).toBe(2);
		for (const [label, delay] of [
			["attemptMs", ATTEMPT_MS],
			["totalMs", TOTAL_MS],
			["backoff", BACKOFF_MS],
		] as const) {
			const spies = unrefByDelay.get(delay) ?? [];
			expect(spies.length, `${label} timer created`).toBeGreaterThan(0);
			for (const spy of spies) expect(spy, `${label} timer unref'd`).toHaveBeenCalled();
		}
	});
});
