import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	arrivalsFor,
	END,
	MIN_REQ,
	PCT,
	simulate,
	TIMEOUT,
	WINDOW_SEC,
} from "../../site/demos/models/circuit-breaker.js";
import { HttpClient } from "../../src/core/client.ts";

// The circuit breaker demo on the website runs a hand-written model so its
// sliders can re-run instantly. This test keeps that model honest: it sends the
// demo's exact traffic through the real HttpClient, under fake timers, and
// checks that the breaker opens and closes at the same moments the model says.
// If the library's breaker changes, this fails until the demo is updated.

type Options = { scenario: "down" | "flaky"; mode: "consec" | "window"; threshold: number; resetSec: number };

/** Open/close transitions from the real client: [seconds, "open" | "closed"]. */
async function runReal(o: Options): Promise<Array<[number, string]>> {
	const arrivals = arrivalsFor(o);
	const transitions: Array<[number, string]> = [];
	const client = HttpClient.create({
		timeout: { attemptMs: TIMEOUT * 1000 },
		retry: { maxRetries: 0 },
		circuitBreaker: {
			enabled: true,
			resetTimeoutMs: o.resetSec * 1000,
			halfOpenMaxAttempts: 1,
			...(o.mode === "window"
				? { window: { sizeMs: WINDOW_SEC * 1000, failureRatePercent: PCT, minimumRequests: MIN_REQ } }
				: { failureThreshold: o.threshold }),
		},
		// The demo's host: a failing request hangs until the attempt timeout
		// aborts it; the others answer after their latency.
		fetch: (input, init) => {
			const id = Number(new URL(String(input)).pathname.split("/").pop());
			const a = arrivals[id];
			return new Promise<Response>((resolve, reject) => {
				init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
				if (!a.fails) setTimeout(() => resolve(new Response("ok")), a.lat * 1000);
			});
		},
	});
	client.on("circuitOpen", () => transitions.push([Date.now() / 1000, "open"]));
	client.on("circuitClose", () => transitions.push([Date.now() / 1000, "closed"]));

	for (const a of arrivals) {
		setTimeout(() => {
			void client.get(`http://host.test/r/${a.id}`).toPromise();
		}, a.t * 1000);
	}
	await vi.advanceTimersByTimeAsync((END + 2) * 1000);
	await client.close();
	return transitions;
}

/** The model's open/close transitions (it also records half-open, which emits no event). */
function runModel(o: Options): Array<[number, string]> {
	const states = simulate(o).lanes.with.states ?? [];
	return states
		.slice(1)
		.filter((s) => s.state !== "half-open")
		.map((s): [number, string] => [s.t, s.state]);
}

describe("circuit breaker demo model matches the real HttpClient", () => {
	beforeEach(() => {
		vi.useFakeTimers({ now: 0 });
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	const cases: Options[] = [
		{ scenario: "down", mode: "consec", threshold: 5, resetSec: 4 },
		{ scenario: "down", mode: "consec", threshold: 1, resetSec: 1 },
		{ scenario: "down", mode: "consec", threshold: 10, resetSec: 8 },
		{ scenario: "flaky", mode: "consec", threshold: 5, resetSec: 4 },
		{ scenario: "flaky", mode: "consec", threshold: 2, resetSec: 2 },
		{ scenario: "flaky", mode: "window", threshold: 5, resetSec: 4 },
		{ scenario: "down", mode: "window", threshold: 5, resetSec: 2 },
		// Reset shorter than the window: the failures that opened the breaker are
		// still inside the window when it closes, so this checks that closing
		// starts an empty window (#219).
		{ scenario: "flaky", mode: "window", threshold: 5, resetSec: 1 },
	];

	for (const o of cases) {
		it(`${o.scenario} host, ${o.mode === "window" ? `failure rate > ${PCT}%` : `${o.threshold} failures in a row`}, reset ${o.resetSec} s`, async () => {
			const real = await runReal(o);
			const model = runModel(o);
			expect(real.map(([, s]) => s)).toEqual(model.map(([, s]) => s));
			real.forEach(([t], i) => {
				// Timers fire on whole milliseconds; the model uses exact seconds.
				expect(t).toBeCloseTo(model[i][0], 2);
			});
		});
	}
});
