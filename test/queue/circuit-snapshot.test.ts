import * as http from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpClient } from "../../src/core/client.ts";
import { CircuitOpenError, NetworkError } from "../../src/core/errors.ts";
import { CircuitBreaker, CircuitBreakerRegistry } from "../../src/queue/circuit-breaker.ts";

const boom = () => new NetworkError("boom");

describe("CircuitBreaker.snapshot()", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(1_000_000);
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("walks closed -> open -> half_open -> closed", () => {
		const cb = new CircuitBreaker("api", { enabled: true, failureThreshold: 2, resetTimeoutMs: 500 });

		expect(cb.snapshot()).toEqual({ partition: "api", state: "closed", failures: 0 });

		cb.recordFailure(boom());
		expect(cb.snapshot()).toEqual({ partition: "api", state: "closed", failures: 1 });

		cb.recordFailure(boom());
		expect(cb.snapshot()).toEqual({
			partition: "api",
			state: "open",
			failures: 2,
			openedAt: 1_000_000,
			nextAttemptAt: 1_000_500,
		});

		// Elapsed but not yet observed by a request: still reported open.
		vi.advanceTimersByTime(500);
		expect(cb.snapshot().state).toBe("open");

		const permit = cb.tryAcquire();
		expect(permit).not.toBeNull();
		expect(cb.snapshot()).toMatchObject({ state: "half_open", openedAt: 1_000_000, nextAttemptAt: 1_000_500 });

		permit?.success();
		expect(cb.snapshot()).toEqual({ partition: "api", state: "closed", failures: 0 });
	});

	it("reports a failed half-open trial as open again, with fresh timestamps", () => {
		const cb = new CircuitBreaker("api", { enabled: true, failureThreshold: 1, resetTimeoutMs: 500 });
		cb.recordFailure(boom());
		vi.advanceTimersByTime(500);
		cb.tryAcquire()?.failure(boom());

		expect(cb.snapshot()).toMatchObject({ state: "open", openedAt: 1_000_500, nextAttemptAt: 1_001_000 });
	});

	it("counts failures in the rolling window when one is configured", () => {
		const cb = new CircuitBreaker("api", {
			enabled: true,
			window: { sizeMs: 1_000, minimumRequests: 10, failureRatePercent: 50 },
		});
		cb.recordFailure(boom());
		cb.recordSuccess();
		cb.recordFailure(boom());
		expect(cb.snapshot().failures).toBe(2);

		// Both failures age out of the window.
		vi.advanceTimersByTime(2_000);
		expect(cb.snapshot().failures).toBe(0);
	});

	it("returns a copy: mutating it doesn't affect the breaker", () => {
		const cb = new CircuitBreaker("api", { enabled: true, failureThreshold: 1 });
		const snap = cb.snapshot();
		snap.state = "open";
		snap.failures = 99;

		expect(cb.canRequest()).toBe(true);
		expect(cb.snapshot()).toEqual({ partition: "api", state: "closed", failures: 0 });
	});
});

describe("CircuitBreakerRegistry.getAll()", () => {
	it("skips disabled breakers", () => {
		const registry = new CircuitBreakerRegistry(
			{ enabled: false },
			{ "on.example": { circuitBreaker: { enabled: true } } },
		);
		registry.get("off.example");
		registry.get("on.example");

		expect(registry.getAll().map((s) => s.partition)).toEqual(["on.example"]);
	});
});

describe("client.circuits()", () => {
	function createServer(): Promise<{ url: string; host: string; close: () => Promise<void> }> {
		return new Promise((resolve) => {
			const server = http.createServer((_req, res) => {
				res.statusCode = 503;
				res.end("down");
			});
			server.listen(0, "127.0.0.1", () => {
				const addr = server.address();
				const port = typeof addr === "string" || addr === null ? 0 : addr.port;
				resolve({
					url: `http://127.0.0.1:${port}`,
					host: `127.0.0.1:${port}`,
					close: () => new Promise<void>((r) => server.close(() => r())),
				});
			});
		});
	}

	it("is empty when no breaker is configured", async () => {
		const { url, close } = await createServer();
		try {
			const client = HttpClient.create({ baseUrl: url, timeout: { attemptMs: 5_000 }, retry: { maxRetries: 0 } });
			await client.get("/").toPromise();
			expect(client.circuits()).toEqual([]);
		} finally {
			await close();
		}
	});

	it("reports the partition whose breaker tripped", async () => {
		const { url, host, close } = await createServer();
		try {
			const client = HttpClient.create({
				baseUrl: url,
				timeout: { attemptMs: 5_000 },
				retry: { maxRetries: 0 },
				circuitBreaker: { enabled: true, failureThreshold: 2, resetTimeoutMs: 60_000 },
			});
			await client.get("/").toPromise();
			await client.get("/").toPromise();
			const rejected = await client.get("/").toPromise();
			expect(!rejected.success && rejected.error).toBeInstanceOf(CircuitOpenError);

			const [snap] = client.circuits();
			expect(snap).toMatchObject({ partition: host, state: "open", failures: 2 });
			expect(snap?.nextAttemptAt).toBe((snap?.openedAt ?? 0) + 60_000);
		} finally {
			await close();
		}
	});
});
