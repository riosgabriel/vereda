import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpClient } from "../../src/core/client.ts";
import { CircuitOpenError, ConfigurationError, MaxRetriesExceededError } from "../../src/core/errors.ts";
import { type Fault, faultyFetch } from "../../src/testing/index.ts";

const URL_ = "https://api.test/items";

/** A stand-in for the real network: answers 200 and counts calls. */
function okFetch() {
	return vi.fn<typeof fetch>(async () => new Response("inner", { status: 200 }));
}

/** What each of `n` calls turned into: a status, `"throw"`, or `"pass"` for the inner 200. */
async function outcomes(f: typeof fetch, n: number): Promise<string[]> {
	const seen: string[] = [];
	for (let i = 0; i < n; i++) {
		try {
			const res = await f(URL_);
			seen.push(res.status === 200 ? "pass" : String(res.status));
		} catch {
			seen.push("throw");
		}
	}
	return seen;
}

const MIX: Fault[] = [{ status: 503 }, { status: 429 }, { networkError: true }];

beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
});

describe("faultyFetch: sequence", () => {
	it("gives the same faults in the same order for the same seed", async () => {
		const a = await outcomes(faultyFetch(okFetch(), { faults: MIX, rate: 0.6, seed: 7 }), 40);
		const b = await outcomes(faultyFetch(okFetch(), { faults: MIX, rate: 0.6, seed: 7 }), 40);
		expect(a).toEqual(b);
		expect(new Set(a).size).toBeGreaterThan(2);
	});

	it("differs between seeds", async () => {
		const a = await outcomes(faultyFetch(okFetch(), { faults: MIX, rate: 0.6, seed: 1 }), 40);
		const b = await outcomes(faultyFetch(okFetch(), { faults: MIX, rate: 0.6, seed: 2 }), 40);
		expect(a).not.toEqual(b);
	});

	it("rate 0 always passes through", async () => {
		const inner = okFetch();
		const seen = await outcomes(faultyFetch(inner, { faults: MIX, rate: 0, seed: 3 }), 20);
		expect(seen.every((s) => s === "pass")).toBe(true);
		expect(inner).toHaveBeenCalledTimes(20);
	});

	it("rate 1 (the default) always faults", async () => {
		const inner = okFetch();
		const seen = await outcomes(faultyFetch(inner, { faults: MIX, seed: 3 }), 20);
		expect(seen.some((s) => s === "pass")).toBe(false);
		expect(inner).not.toHaveBeenCalled();
	});

	it("keeps the fault picks stable when only the rate changes", async () => {
		const full = await outcomes(faultyFetch(okFetch(), { faults: MIX, rate: 1, seed: 9 }), 30);
		const half = await outcomes(faultyFetch(okFetch(), { faults: MIX, rate: 0.5, seed: 9 }), 30);
		half.forEach((s, i) => {
			if (s !== "pass") expect(s).toBe(full[i]);
		});
	});
});

describe("faultyFetch: status", () => {
	it("answers without calling inner, with the given status, body and Retry-After", async () => {
		const inner = okFetch();
		const f = faultyFetch(inner, {
			faults: [{ status: 503, retryAfter: 2, body: "down", headers: { "x-fault": "1" } }],
		});
		const res = await f(URL_);
		expect(res.status).toBe(503);
		expect(await res.text()).toBe("down");
		expect(res.headers.get("retry-after")).toBe("2");
		expect(res.headers.get("x-fault")).toBe("1");
		expect(inner).not.toHaveBeenCalled();
	});

	it("sends a numeric Retry-After that Vereda's parser reads", async () => {
		const res = await faultyFetch(okFetch(), { faults: [{ status: 429, retryAfter: 0 }] })(URL_);
		expect(res.headers.get("retry-after")).toBe("0");
	});

	it("passes a string Retry-After through as is", async () => {
		const date = "Sun, 06 Nov 1994 08:49:37 GMT";
		const res = await faultyFetch(okFetch(), { faults: [{ status: 429, retryAfter: date }] })(URL_);
		expect(res.headers.get("retry-after")).toBe(date);
	});
});

describe("faultyFetch: networkError", () => {
	it("rejects with the abort reason first when the signal is already aborted", async () => {
		const f = faultyFetch(okFetch(), { faults: [{ networkError: true }] });
		await expect(f(URL_, { signal: AbortSignal.abort(new Error("gone")) })).rejects.toThrow("gone");
	});

	it("rejects with a TypeError", async () => {
		const inner = okFetch();
		const f = faultyFetch(inner, { faults: [{ networkError: true }] });
		await expect(f(URL_)).rejects.toBeInstanceOf(TypeError);
		expect(inner).not.toHaveBeenCalled();
	});
});

describe("faultyFetch: latency", () => {
	it("waits the full latencyMs past the 2^31 - 1 ms timer limit", async () => {
		const inner = okFetch();
		const f = faultyFetch(inner, { faults: [{ latencyMs: 2_147_483_647 + 5_000 }] });
		const p = f(URL_);
		await vi.advanceTimersByTimeAsync(10_000);
		expect(inner).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(2_147_483_647);
		expect((await p).status).toBe(200);
	});

	it("calls inner only after latencyMs", async () => {
		const inner = okFetch();
		const f = faultyFetch(inner, { faults: [{ latencyMs: 2_000 }] });
		const p = f(URL_);
		await vi.advanceTimersByTimeAsync(1_999);
		expect(inner).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		expect((await p).status).toBe(200);
		expect(inner).toHaveBeenCalledTimes(1);
	});

	it("rejects with the signal's reason on abort during the wait, clears the timer, never calls inner", async () => {
		const inner = okFetch();
		const f = faultyFetch(inner, { faults: [{ latencyMs: 2_000 }] });
		const ac = new AbortController();
		const p = f(URL_, { signal: ac.signal });
		const assertion = expect(p).rejects.toBe("stop");
		await vi.advanceTimersByTimeAsync(500);
		expect(vi.getTimerCount()).toBe(1);
		ac.abort("stop");
		await assertion;
		expect(vi.getTimerCount()).toBe(0);
		await vi.advanceTimersByTimeAsync(5_000);
		expect(inner).not.toHaveBeenCalled();
	});

	it("rejects at once on an already-aborted signal, reading it from a Request input", async () => {
		const inner = okFetch();
		const f = faultyFetch(inner, { faults: [{ latencyMs: 2_000 }] });
		const ac = new AbortController();
		ac.abort();
		await expect(f(new Request(URL_, { signal: ac.signal }))).rejects.toMatchObject({ name: "AbortError" });
		expect(vi.getTimerCount()).toBe(0);
		expect(inner).not.toHaveBeenCalled();
	});
});

describe("faultyFetch: hang", () => {
	it("never settles on its own", async () => {
		const inner = okFetch();
		const settled = vi.fn();
		faultyFetch(inner, { faults: [{ hang: true }] })(URL_).then(settled, settled);
		await vi.advanceTimersByTimeAsync(10 * 60_000);
		expect(settled).not.toHaveBeenCalled();
		expect(inner).not.toHaveBeenCalled();
	});

	it("rejects when the signal aborts", async () => {
		const f = faultyFetch(okFetch(), { faults: [{ hang: true }] });
		const ac = new AbortController();
		const p = f(URL_, { signal: ac.signal });
		const assertion = expect(p).rejects.toMatchObject({ name: "AbortError" });
		ac.abort();
		await assertion;
	});

	it("rejects at once when already aborted", async () => {
		const f = faultyFetch(okFetch(), { faults: [{ hang: true }] });
		await expect(f(URL_, { signal: AbortSignal.abort(new Error("gone")) })).rejects.toThrow("gone");
	});
});

/** A Request from another realm: same shape, not an `instanceof Request`. */
class ForeignRequest {
	readonly url = URL_;
	readonly method = "PUT";
	readonly headers = new Headers({ "x-a": "1" });
	constructor(readonly signal: AbortSignal) {}
}

describe("faultyFetch: Request from another realm", () => {
	it("hang sees its signal", async () => {
		const f = faultyFetch(okFetch(), { faults: [{ hang: true }] });
		const ac = new AbortController();
		const p = f(new ForeignRequest(ac.signal) as never);
		const assertion = expect(p).rejects.toMatchObject({ name: "AbortError" });
		ac.abort();
		await assertion;
	});

	it("match sees its URL, method and headers", async () => {
		const seen: unknown[] = [];
		const f = faultyFetch(okFetch(), {
			faults: [{ status: 500 }],
			match: (req) => {
				seen.push([req.url, req.method, req.headers.get("x-a")]);
				return true;
			},
		});
		expect((await f(new ForeignRequest(new AbortController().signal) as never)).status).toBe(500);
		expect(seen).toEqual([[URL_, "PUT", "1"]]);
	});
});

describe("faultyFetch: match", () => {
	it("adds no abort listener to the caller's signal", async () => {
		const ac = new AbortController();
		const add = vi.spyOn(ac.signal, "addEventListener");
		const f = faultyFetch(okFetch(), { faults: [{ status: 500 }], rate: 0, match: () => true });
		await f(URL_, { signal: ac.signal });
		expect(add).not.toHaveBeenCalled();
	});

	it("passes non-matching calls through", async () => {
		const inner = okFetch();
		const f = faultyFetch(inner, {
			faults: [{ status: 500 }],
			match: (req) => new URL(req.url).hostname === "flaky.test",
		});
		expect((await f("https://fine.test/")).status).toBe(200);
		expect((await f("https://flaky.test/")).status).toBe(500);
		expect(inner).toHaveBeenCalledTimes(1);
	});

	it("sees the method and headers, and leaves the body for the real call", async () => {
		const inner = okFetch();
		const seen: Array<[string, string | null]> = [];
		const f = faultyFetch(inner, {
			faults: [{ status: 500 }],
			rate: 0,
			match: (req) => {
				seen.push([req.method, req.headers.get("x-a")]);
				return true;
			},
		});
		const request = new Request(URL_, { method: "POST", body: "payload", headers: { "x-a": "1" } });
		await f(request);
		expect(seen).toEqual([["POST", "1"]]);
		expect(request.bodyUsed).toBe(false);
	});

	it("takes no draws for calls it rejects, so the sequence is unchanged", async () => {
		const plain = faultyFetch(okFetch(), { faults: MIX, rate: 0.6, seed: 11 });
		let skip = true;
		const matched = faultyFetch(okFetch(), {
			faults: MIX,
			rate: 0.6,
			seed: 11,
			match: () => {
				skip = !skip;
				return skip;
			},
		});
		const expected = await outcomes(plain, 15);
		// every other call is skipped; the calls that match see the plain sequence
		const got = (await outcomes(matched, 30)).filter((_, i) => i % 2 === 1);
		expect(got).toEqual(expected);
	});
});

describe("faultyFetch: options are validated eagerly", () => {
	const ok = okFetch();
	const bad: Array<[string, unknown]> = [
		["rate above 1", { faults: [{ hang: true }], rate: 1.5 }],
		["rate below 0", { faults: [{ hang: true }], rate: -0.1 }],
		["rate NaN", { faults: [{ hang: true }], rate: Number.NaN }],
		["no faults", { faults: [] }],
		["faults missing", {}],
		["options null", null],
		["options a string", "faults"],
		["non-integer seed", { faults: [{ hang: true }], seed: 1.5 }],
		["empty fault", { faults: [{}] }],
		["two shapes in one fault", { faults: [{ status: 500, hang: true }] }],
		["status 99", { faults: [{ status: 99 }] }],
		["status 600", { faults: [{ status: 600 }] }],
		["status 503.5", { faults: [{ status: 503.5 }] }],
		["body on a 204", { faults: [{ status: 204, body: "x" }] }],
		["negative retryAfter", { faults: [{ status: 503, retryAfter: -1 }] }],
		["fractional retryAfter", { faults: [{ status: 503, retryAfter: 0.5 }] }],
		["retryAfter beyond safe integers", { faults: [{ status: 503, retryAfter: 1e21 }] }],
		["empty retryAfter string", { faults: [{ status: 503, retryAfter: "" }] }],
		["retryAfter string with a newline", { faults: [{ status: 503, retryAfter: "1\n2" }] }],
		["invalid header name", { faults: [{ status: 503, headers: { "bad name": "x" } }] }],
		["invalid header value", { faults: [{ status: 503, headers: { "x-a": "a\nb" } }] }],
		["non-string body", { faults: [{ status: 503, body: 5 }] }],
		["match not a function", { faults: [{ hang: true }], match: true }],
		["negative latencyMs", { faults: [{ latencyMs: -1 }] }],
		["infinite latencyMs", { faults: [{ latencyMs: Number.POSITIVE_INFINITY }] }],
		["networkError: false", { faults: [{ networkError: false }] }],
		["hang: false", { faults: [{ hang: false }] }],
	];
	it.each(bad)("throws ConfigurationError for %s", (_name, options) => {
		expect(() => faultyFetch(ok, options as never)).toThrow(ConfigurationError);
	});

	it("throws ConfigurationError when inner is not a function", () => {
		expect(() => faultyFetch("fetch" as never, { faults: [{ hang: true }] })).toThrow(ConfigurationError);
	});

	it("builds a fresh Headers for each response", async () => {
		const f = faultyFetch(ok, { faults: [{ status: 503, retryAfter: 1, headers: { "x-a": "1" } }] });
		const a = await f(URL_);
		a.headers.set("x-a", "changed");
		expect((await f(URL_)).headers.get("x-a")).toBe("1");
	});
});

describe("faultyFetch with HttpClient", () => {
	it("retries a persistent 503 and ends in MaxRetriesExceededError after 3 calls", async () => {
		vi.useRealTimers();
		const inner = okFetch();
		const client = HttpClient.create({
			timeout: { attemptMs: 1_000 },
			retry: { maxRetries: 2, backoff: { baseDelayMs: 1, jitter: false } },
			fetch: faultyFetch(inner, { faults: [{ status: 503 }], seed: 1, rate: 1 }),
		});
		const result = await client.get(URL_).toPromise();
		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.error).toBeInstanceOf(MaxRetriesExceededError);
			expect(result.error.kind).toBe("max_retries");
			expect((result.error as MaxRetriesExceededError).attempts).toBe(3);
		}
		expect(inner).not.toHaveBeenCalled();
		await client.close();
	});

	it("opens the circuit breaker and then stops calling the host", async () => {
		vi.useRealTimers();
		const attempts = vi.fn();
		const client = HttpClient.create({
			timeout: { attemptMs: 1_000 },
			retry: { maxRetries: 0 },
			circuitBreaker: { enabled: true, failureThreshold: 3, resetTimeoutMs: 60_000 },
			fetch: faultyFetch(
				(async (...args) => {
					attempts(...args);
					return new Response("ok");
				}) as typeof fetch,
				{ faults: [{ status: 503 }, { networkError: true }], seed: 1 },
			),
		});
		for (let i = 0; i < 3; i++) await client.get(URL_).toPromise();
		const blocked = await client.get(URL_).toPromise();
		expect(blocked.success).toBe(false);
		if (!blocked.success) expect(blocked.error).toBeInstanceOf(CircuitOpenError);
		expect(client.circuits()[0]?.state).toBe("open");
		expect(attempts).not.toHaveBeenCalled();
		await client.close();
	});
});
