import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_TIMER_MS, setLongTimeout } from "../../src/core/timer.ts";

// #203: Node fires any setTimeout delay above MAX_TIMER_MS after ~1 ms, so
// setLongTimeout must never hand setTimeout a delay it can't hold.
describe("setLongTimeout", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("fires once after a short delay", () => {
		const callback = vi.fn();
		setLongTimeout(callback, 100);
		vi.advanceTimersByTime(99);
		expect(callback).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(callback).toHaveBeenCalledTimes(1);
	});

	it("waits the full delay past MAX_TIMER_MS, arming no timer longer than it", () => {
		const spy = vi.spyOn(globalThis, "setTimeout");
		const callback = vi.fn();
		const ms = MAX_TIMER_MS * 2 + 500;
		setLongTimeout(callback, ms);

		vi.advanceTimersByTime(ms - 1);
		expect(callback).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(callback).toHaveBeenCalledTimes(1);

		const delays = spy.mock.calls.map((call) => call[1] ?? 0);
		expect(delays.length).toBeGreaterThan(1);
		for (const delay of delays) expect(delay).toBeLessThanOrEqual(MAX_TIMER_MS);
	});

	it("cancels before the callback, including between chained timers", () => {
		const callback = vi.fn();
		const cancel = setLongTimeout(callback, MAX_TIMER_MS + 1_000);
		vi.advanceTimersByTime(MAX_TIMER_MS + 10);
		cancel();
		vi.advanceTimersByTime(MAX_TIMER_MS);
		expect(callback).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("treats cancel after the callback as a no-op", () => {
		const callback = vi.fn();
		const cancel = setLongTimeout(callback, 10);
		vi.advanceTimersByTime(10);
		expect(() => cancel()).not.toThrow();
		expect(callback).toHaveBeenCalledTimes(1);
	});

	it("unrefs every timer it arms", () => {
		const unrefs: ReturnType<typeof vi.fn>[] = [];
		const realSetTimeout = globalThis.setTimeout;
		vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, delay?: number) => {
			const timer = realSetTimeout(fn, delay);
			const unref = vi.fn(() => timer);
			unrefs.push(unref);
			return Object.assign(timer, { unref });
		}) as typeof setTimeout);
		setLongTimeout(() => {}, MAX_TIMER_MS + 1);
		vi.advanceTimersByTime(MAX_TIMER_MS + 1);
		expect(unrefs.length).toBe(2);
		for (const unref of unrefs) expect(unref).toHaveBeenCalled();
	});
});
