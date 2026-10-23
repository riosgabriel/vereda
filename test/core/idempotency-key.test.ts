import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpClient } from "../../src/core/client.ts";
import { uuidV4 } from "../../src/core/nanoid.ts";
import type { RetryConfig } from "../../src/core/types.ts";
import { validateConfig } from "../../src/core/validate.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const URL_ = "http://example.test/orders";

describe("retry.idempotencyKey (fake timers)", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	function ok(): Response {
		return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
	}
	function busy(): Response {
		return new Response("busy", { status: 503 });
	}
	function make(fetchMock: ReturnType<typeof vi.fn>, retry: RetryConfig = {}) {
		return HttpClient.create({
			timeout: { attemptMs: 5_000 },
			fetch: fetchMock as unknown as typeof globalThis.fetch,
			retry: { backoff: { baseDelayMs: 10, jitter: false }, ...retry },
		});
	}
	function keyOf(fetchMock: ReturnType<typeof vi.fn>, call: number): string | null {
		const init = fetchMock.mock.calls[call]?.[1] as RequestInit;
		return new Headers(init.headers).get("Idempotency-Key");
	}
	async function run<T extends { toPromise(): Promise<unknown> }>(ticket: T) {
		const p = ticket.toPromise();
		await vi.advanceTimersByTimeAsync(5_000);
		return p as Promise<{ success: boolean }>;
	}

	it("sends the same UUID key on every attempt of a retried POST", async () => {
		const fetchMock = vi.fn().mockResolvedValueOnce(busy()).mockResolvedValueOnce(ok());
		const client = make(fetchMock, { idempotencyKey: true });
		const result = await run(client.post(URL_, () => "{}"));
		expect(result.success).toBe(true);
		expect(fetchMock).toHaveBeenCalledTimes(2);
		const first = keyOf(fetchMock, 0);
		expect(first).toMatch(UUID);
		expect(keyOf(fetchMock, 1)).toBe(first);
	});

	it("does not retry a POST 503 without the option", async () => {
		const fetchMock = vi.fn().mockResolvedValue(busy());
		const client = make(fetchMock);
		const result = await run(client.post(URL_, () => "{}"));
		expect(result.success).toBe(false);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(keyOf(fetchMock, 0)).toBeNull();
	});

	it("gives separate requests different keys", async () => {
		const fetchMock = vi.fn().mockImplementation(async () => ok());
		const client = make(fetchMock, { idempotencyKey: true });
		await run(client.post(URL_, () => "{}"));
		await run(client.post(URL_, () => "{}"));
		expect(keyOf(fetchMock, 0)).not.toBe(keyOf(fetchMock, 1));
	});

	it.each(["Idempotency-Key", "idempotency-key"])("keeps a caller-supplied %s", async (name) => {
		const fetchMock = vi.fn().mockResolvedValueOnce(busy()).mockResolvedValueOnce(ok());
		const client = make(fetchMock, { idempotencyKey: true });
		const result = await run(client.post(URL_, () => "{}", { headers: { [name]: "mine" } }));
		expect(result.success).toBe(true);
		expect(fetchMock).toHaveBeenCalledTimes(2);
		for (const call of [0, 1]) {
			const init = fetchMock.mock.calls[call]?.[1] as RequestInit;
			const h = new Headers(init.headers);
			expect(h.get("idempotency-key")).toBe("mine");
		}
	});

	it("adds no key to a GET", async () => {
		const fetchMock = vi.fn().mockResolvedValue(ok());
		const client = make(fetchMock, { idempotencyKey: true });
		await run(client.get(URL_));
		expect(keyOf(fetchMock, 0)).toBeNull();
	});

	it("calls a custom generator once per request, even with retries", async () => {
		const fetchMock = vi.fn().mockResolvedValueOnce(busy()).mockResolvedValueOnce(busy()).mockResolvedValueOnce(ok());
		const generator = vi.fn(() => "custom-key-1");
		const client = make(fetchMock, { idempotencyKey: generator });
		const result = await run(client.post(URL_, () => "{}"));
		expect(result.success).toBe(true);
		expect(fetchMock).toHaveBeenCalledTimes(3);
		expect(generator).toHaveBeenCalledTimes(1);
		for (const call of [0, 1, 2]) expect(keyOf(fetchMock, call)).toBe("custom-key-1");
	});

	it("lets a request-level false override a client-level true", async () => {
		const fetchMock = vi.fn().mockResolvedValue(busy());
		const client = make(fetchMock, { idempotencyKey: true });
		const result = await run(client.post(URL_, () => "{}", { retry: { idempotencyKey: false } }));
		expect(result.success).toBe(false);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(keyOf(fetchMock, 0)).toBeNull();
	});

	it("honors a partition-level setting", async () => {
		const fetchMock = vi.fn().mockResolvedValueOnce(busy()).mockResolvedValueOnce(ok());
		const client = HttpClient.create({
			timeout: { attemptMs: 5_000 },
			fetch: fetchMock as unknown as typeof globalThis.fetch,
			retry: { backoff: { baseDelayMs: 10, jitter: false } },
			partitions: { "example.test": { retry: { idempotencyKey: true } } },
		});
		const result = await run(client.post(URL_, () => "{}"));
		expect(result.success).toBe(true);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("shows the key to middleware on each attempt", async () => {
		const fetchMock = vi.fn().mockResolvedValueOnce(busy()).mockResolvedValueOnce(ok());
		const client = make(fetchMock, { idempotencyKey: true });
		const seen: Array<string | null> = [];
		client.use(async (ctx, next) => {
			seen.push(ctx.headers.get("Idempotency-Key"));
			return next(ctx);
		});
		await run(client.post(URL_, () => "{}"));
		expect(seen).toHaveLength(2);
		expect(seen[0]).toMatch(UUID);
		expect(seen[1]).toBe(seen[0]);
	});

	it("does not mutate the caller's headers", async () => {
		const fetchMock = vi.fn().mockResolvedValue(ok());
		const client = make(fetchMock, { idempotencyKey: true });
		const plain = { "X-Test": "1" };
		const instance = new Headers({ "X-Test": "1" });
		const tuples: [string, string][] = [["X-Test", "1"]];
		for (const headers of [plain, instance, tuples]) {
			await run(client.post(URL_, () => "{}", { headers }));
			expect(keyOf(fetchMock, fetchMock.mock.calls.length - 1)).toMatch(UUID);
		}
		expect(plain).toEqual({ "X-Test": "1" });
		expect(instance.has("Idempotency-Key")).toBe(false);
		expect(tuples).toEqual([["X-Test", "1"]]);
	});

	it.each([
		[
			"throws",
			() => {
				throw new Error("boom");
			},
		],
		["returns an empty string", () => ""],
		["returns a non-string", () => 42 as unknown as string],
		["returns a blank string", () => "   "],
	])("fails with ConfigurationError when the generator %s", async (_name, generator) => {
		const fetchMock = vi.fn().mockResolvedValue(ok());
		const client = make(fetchMock, { idempotencyKey: generator });
		const result = (await run(client.post(URL_, () => "{}"))) as { success: boolean; error?: { kind: string } };
		expect(result.success).toBe(false);
		expect(result.error?.kind).toBe("configuration");
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it.each([
		["a non-Latin-1 key", () => "ключ"],
		["a key with a newline", () => "a\nb"],
	])("fails with ConfigurationError caused by a TypeError when the generator returns %s", async (_name, generator) => {
		const fetchMock = vi.fn().mockResolvedValue(ok());
		const client = make(fetchMock, { idempotencyKey: generator });
		const result = (await run(client.post(URL_, () => "{}"))) as {
			success: boolean;
			error?: { kind: string; cause?: unknown };
		};
		expect(result.success).toBe(false);
		expect(result.error?.kind).toBe("configuration");
		expect(result.error?.cause).toBeInstanceOf(TypeError);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("fails with ConfigurationError for an invalid caller header name when the option is on", async () => {
		const fetchMock = vi.fn().mockResolvedValue(ok());
		const client = make(fetchMock, { idempotencyKey: true });
		const result = (await run(client.post(URL_, () => "{}", { headers: { "bad header": "x" } }))) as {
			success: boolean;
			error?: { kind: string; cause?: unknown };
		};
		expect(result.success).toBe(false);
		expect(result.error?.kind).toBe("configuration");
		expect(result.error?.cause).toBeInstanceOf(TypeError);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("leaves an invalid caller header name a network error when the option is off", async () => {
		const fetchMock = vi.fn().mockResolvedValue(ok());
		const client = make(fetchMock);
		const result = (await run(client.post(URL_, () => "{}", { headers: { "bad header": "x" } }))) as {
			success: boolean;
			error?: { kind: string };
		};
		expect(result.success).toBe(false);
		expect(result.error?.kind).toBe("network");
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("replaces an empty caller Idempotency-Key with a generated one", async () => {
		const fetchMock = vi.fn().mockResolvedValueOnce(busy()).mockResolvedValueOnce(ok());
		const client = make(fetchMock, { idempotencyKey: true });
		const result = await run(client.post(URL_, () => "{}", { headers: { "Idempotency-Key": "" } }));
		expect(result.success).toBe(true);
		expect(fetchMock).toHaveBeenCalledTimes(2);
		const first = keyOf(fetchMock, 0);
		expect(first).toMatch(UUID);
		expect(keyOf(fetchMock, 1)).toBe(first);
	});

	it("builds RFC 4122 v4 UUIDs that differ between calls", () => {
		const v4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
		const a = uuidV4();
		const b = uuidV4();
		expect(a).toMatch(v4);
		expect(b).toMatch(v4);
		expect(a).not.toBe(b);
	});
});

describe("retry.idempotencyKey validation", () => {
	it("rejects a value that is neither boolean nor function", () => {
		expect(() =>
			validateConfig({ timeout: { attemptMs: 5_000 }, retry: { idempotencyKey: "auto" as unknown as boolean } }),
		).toThrow("retry.idempotencyKey must be a boolean or a function");
	});

	it("accepts true, false and a function", () => {
		for (const idempotencyKey of [true, false, () => "k"]) {
			expect(() => validateConfig({ timeout: { attemptMs: 5_000 }, retry: { idempotencyKey } })).not.toThrow();
		}
	});
});
