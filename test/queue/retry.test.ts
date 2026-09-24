import { describe, expect, it, vi } from "vitest";
import { NetworkError, QueueFullError } from "../../src/core/errors.js";
import { Bulkhead } from "../../src/queue/bulkhead.js";
import { CircuitBreaker } from "../../src/queue/circuit-breaker.js";
import { runRetryLoop } from "../../src/queue/retry.js";
import { createTicket } from "../../src/ticket/ticket.js";

// A disabled breaker is always inert (canRequest() always true, record*() no-ops),
// so it's safe to pass into every test here that isn't exercising the breaker itself.
const disabledBreaker = () => new CircuitBreaker("test", { enabled: false });

describe("runRetryLoop", () => {
	it("with maxRetries: 0, marks done with the raw first error (never wraps in MaxRetriesExceededError)", async () => {
		const { ticket, controller } = createTicket<unknown>("t-zero-retries");
		const bulkhead = new Bulkhead("test");
		const firstError = new NetworkError("connection reset");
		const onFailure = vi.fn();

		await runRetryLoop({
			url: "http://example.test/resource",
			displayUrl: "http://example.test/resource",
			requestOptions: {},
			timeoutConfig: {},
			retryConfig: { maxRetries: 0 },
			ticket,
			controller,
			middleware: [],
			bulkhead,
			circuitBreaker: disabledBreaker(),
			partition: "test",
			firstError,
			initialQueuedMs: 0,
			onFailure,
		});

		expect(onFailure).toHaveBeenCalledWith(firstError, 1, 0);
		expect(ticket.status.state).toBe("done");
		if (ticket.status.state === "done" && !ticket.status.result.success) {
			expect(ticket.status.result.error).toBe(firstError);
		}
	});

	it("marks a ticket cancelled before the first retry iteration when already cancelled", async () => {
		const { ticket, controller } = createTicket<unknown>("t-pre-cancelled");
		const bulkhead = new Bulkhead("test");
		const firstError = new NetworkError("connection reset");
		const onCancelled = vi.fn();
		const onCleanup = vi.fn();

		ticket.cancel();

		await runRetryLoop({
			url: "http://example.test/resource",
			displayUrl: "http://example.test/resource",
			requestOptions: {},
			timeoutConfig: {},
			retryConfig: { maxRetries: 3 },
			ticket,
			controller,
			middleware: [],
			bulkhead,
			circuitBreaker: disabledBreaker(),
			partition: "test",
			firstError,
			initialQueuedMs: 0,
			onCancelled,
			onCleanup,
		});

		// cancel() itself resolves the ticket; runRetryLoop's cancellation guard
		// should still run its cleanup/onCancelled path rather than starting a retry.
		expect(onCleanup).toHaveBeenCalled();
		expect(onCancelled).toHaveBeenCalledWith(1, 0);
	});

	it("preserves accumulated queuedMs when a later retry hits QueueFullError (regression)", async () => {
		// Before the fix, a QueueFullError from bulkhead.run() mid-retry skipped
		// onFailure entirely and let the client's outer .catch() fabricate the
		// failure event from only the first attempt's queuedMs — discarding any
		// real wait time accumulated by retries that ran (and queued) before it.
		const { ticket, controller } = createTicket<unknown>("t-queuefull-midretry");
		const firstError = new NetworkError("connection reset");
		const onFailure = vi.fn();

		const run = vi.fn();
		run.mockImplementationOnce((_task: unknown, _semaphore: unknown, onDequeue?: (ms: number) => void) => {
			onDequeue?.(25); // this retry actually queued for 25ms before running
			return Promise.resolve({ kind: "error", error: new NetworkError("still failing") });
		});
		run.mockImplementation(() => Promise.reject(new QueueFullError("global", 0, 0)));
		const bulkhead = { name: "test", run } as unknown as Bulkhead;

		await expect(
			runRetryLoop({
				url: "http://example.test/resource",
				displayUrl: "http://example.test/resource",
				requestOptions: {},
				timeoutConfig: {},
				retryConfig: { maxRetries: 2, backoff: { baseDelayMs: 0, jitter: false } },
				ticket,
				controller,
				middleware: [],
				bulkhead,
				circuitBreaker: disabledBreaker(),
				partition: "test",
				firstError,
				initialQueuedMs: 5, // the first attempt (outside this loop) queued 5ms
				onFailure,
			}),
		).rejects.toBeInstanceOf(QueueFullError);

		// 5ms (first attempt) + 25ms (the retry that actually ran) must survive —
		// not collapse to just the first attempt's 5ms. attempts is 2, not 3:
		// the rejected bulkhead.run() call never dispatched the task, so it
		// doesn't count as a real attempt.
		expect(onFailure).toHaveBeenCalledWith(expect.any(QueueFullError), 2, 30);
	});

	it("notifies via onCancelled, not onFailure, if the ticket was already cancelled before a retry's QueueFullError arrives (regression)", async () => {
		// Found by review: the QueueFullError catch called onFailure/markDone
		// unconditionally, with no cancellation check — unlike every other
		// checkpoint in this same loop. If the caller cancels the ticket while
		// bulkhead.run() is still pending, cancel() (ticket.ts) resolves the
		// ticket's promise directly; onFailure firing afterward would still
		// reach the client and emit a spurious "failure" event for a ticket
		// whose outcome was actually cancellation.
		const { ticket, controller } = createTicket<unknown>("t-cancel-races-queuefull");
		const firstError = new NetworkError("connection reset");
		const onFailure = vi.fn();
		const onCancelled = vi.fn();

		const bulkhead = {
			name: "test",
			run: vi.fn(() => {
				// Simulate the ticket being cancelled elsewhere while this call
				// was still in flight, settling it before the rejection below is
				// ever observed by the loop.
				ticket.cancel();
				return Promise.reject(new QueueFullError("global", 0, 0));
			}),
		} as unknown as Bulkhead;

		await expect(
			runRetryLoop({
				url: "http://example.test/resource",
				displayUrl: "http://example.test/resource",
				requestOptions: {},
				timeoutConfig: {},
				retryConfig: { maxRetries: 1, backoff: { baseDelayMs: 0, jitter: false } },
				ticket,
				controller,
				middleware: [],
				bulkhead,
				circuitBreaker: disabledBreaker(),
				partition: "test",
				firstError,
				initialQueuedMs: 0,
				onFailure,
				onCancelled,
			}),
		).rejects.toBeInstanceOf(QueueFullError);

		expect(onFailure).not.toHaveBeenCalled();
		// attempts is 1 (the pre-loop first attempt) — the rejected bulkhead.run()
		// call never dispatched a task, so it doesn't count as a real attempt.
		expect(onCancelled).toHaveBeenCalledWith(1, 0);
		expect(ticket.isCancelled).toBe(true);
	});
});
