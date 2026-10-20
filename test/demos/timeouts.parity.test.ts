import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BASE_MS, INF, MAX_DELAY, runModel } from "../../site/demos/models/timeouts.js";
import { HttpClient } from "../../src/core/client.ts";

// The timeouts demo on the website runs a hand-written model so its sliders can
// re-run instantly. This test keeps that model honest: one request goes to a
// host that never answers, through the real HttpClient under fake timers, and
// the attempts, the moment the caller hears back and the error kind must match
// the model. If the library's timeout or retry rules change, this fails until
// the demo is updated.
//
// Not checked: the model's `hostEnd` (the host keeps working 6 s after an
// abort). That is invented physics for the chart; the client cannot observe it.

type Options = { attemptSec: number; totalSec: number; maxRetries: number };
type Real = { attempts: Array<{ start: number; end: number | undefined }>; settledAt?: number; kind?: string };

const RUN_SEC = 60;

/** One request to a host that never answers: fetch rejects only when its signal aborts. */
async function runReal(o: Options): Promise<Real> {
	const real: Real = { attempts: [] };
	const client = HttpClient.create({
		timeout: {
			attemptMs: o.attemptSec * 1000,
			...(o.totalSec === INF ? {} : { totalMs: o.totalSec * 1000 }),
		},
		retry: {
			maxRetries: o.maxRetries,
			backoff: { baseDelayMs: BASE_MS, maxDelayMs: MAX_DELAY * 1000, jitter: false },
		},
		fetch: (_input, init) => {
			const attempt: Real["attempts"][number] = { start: Date.now() / 1000, end: undefined };
			real.attempts.push(attempt);
			return new Promise<Response>((_resolve, reject) => {
				init?.signal?.addEventListener(
					"abort",
					() => {
						attempt.end = Date.now() / 1000;
						reject(init.signal?.reason);
					},
					{ once: true },
				);
			});
		},
	});
	void client
		.get("http://host.test/slow")
		.toPromise()
		.then((r) => {
			real.settledAt = Date.now() / 1000;
			real.kind = r.success ? "ok" : r.error.kind;
		});
	await vi.advanceTimersByTimeAsync(RUN_SEC * 1000);
	// Snapshot before close(): closing aborts whatever is still waiting.
	const snapshot: Real = { ...real, attempts: real.attempts.map((a) => ({ ...a })) };
	await client.close();
	return snapshot;
}

describe("timeouts demo model matches the real HttpClient", () => {
	beforeEach(() => {
		vi.useFakeTimers({ now: 0 });
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	const name = (v: number, unit = " s") => (v === INF ? "off" : `${v}${unit}`);
	const attempts = [1, 2, 3, 5, INF];
	const totals = [1, 2, 2.1, 4, 6, 12, INF];
	const retries = [0, 1, 3, 5];

	for (const attemptSec of attempts) {
		for (const totalSec of totals) {
			for (const maxRetries of retries) {
				const o: Options = { attemptSec, totalSec, maxRetries };
				it(`attemptMs ${name(attemptSec)}, totalMs ${name(totalSec)}, ${maxRetries} retries`, async () => {
					const real = await runReal(o);
					const model = runModel({ attemptSec, maxRetries }, totalSec);

					expect(real.attempts).toHaveLength(model.attempts.length);
					model.attempts.forEach((m, i) => {
						// Timers fire on whole milliseconds; the model uses exact seconds.
						expect(real.attempts[i].start).toBeCloseTo(m.start, 2);
						if (m.end === INF) expect(real.attempts[i].end).toBeUndefined();
						else expect(real.attempts[i].end).toBeCloseTo(m.end, 2);
					});

					if (Number.isFinite(model.answerAt)) {
						expect(real.settledAt).toBeDefined();
						expect(real.settledAt).toBeCloseTo(model.answerAt, 2);
						expect(real.kind).toBe(model.error);
					} else {
						// attemptMs off and no deadline: nothing can end the wait.
						expect(model.error).toBe("never");
						expect(real.settledAt).toBeUndefined();
					}
				});
			}
		}
	}

	it("skips a retry whose backoff would pass the deadline", async () => {
		// attempt #1 ends at 2 s; the 200 ms backoff would end at 2.2 s, past the 2.1 s deadline.
		const o: Options = { attemptSec: 2, totalSec: 2.1, maxRetries: 3 };
		const real = await runReal(o);
		expect(real.attempts).toHaveLength(1);
		expect(real.settledAt).toBeCloseTo(2, 2);
		expect(real.kind).toBe("deadline");
		expect(runModel({ attemptSec: 2, maxRetries: 3 }, 2.1).skipped).toBe(true);
	});

	it("aborts an attempt in flight at the deadline", async () => {
		const o: Options = { attemptSec: 5, totalSec: 1, maxRetries: 3 };
		const real = await runReal(o);
		expect(real.attempts).toHaveLength(1);
		expect(real.attempts[0].end).toBeCloseTo(1, 2);
		expect(real.settledAt).toBeCloseTo(1, 2);
		expect(real.kind).toBe("deadline");
	});
});
