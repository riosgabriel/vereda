import { describe, expect, it, vi } from "vitest";
import { NetworkError } from "../../src/core/errors.js";
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
});
