import { CircuitOpenError, MaxRetriesExceededError } from "@vereda/http";
import { createCheckoutApp } from "./app.ts";
import { createInMemoryMetrics, formatMetricsTable } from "./metrics.ts";
import { startInventoryStub, startPaymentsStub, startShippingStub } from "./stubs.ts";

// ---------------------------------------------------------------------------
// One failing dependency
// ---------------------------------------------------------------------------
//
// A checkout service calls three downstream dependencies through a single
// Vereda `HttpClient`: inventory, payments, shipping. Payments is down (a
// stub that always answers 503). This driver:
//
//   1. starts three stub servers and the checkout app, all in this process,
//      all on 127.0.0.1 ephemeral ports — no network involved;
//   2. fires a handful of checkouts at the real checkout HTTP endpoint;
//   3. prints what happened to each dependency, including retries and the
//      circuit breaker tripping;
//   4. asserts the claims the README makes about bulkhead isolation and
//      circuit breaking, and exits non-zero with a clear message if any of
//      them don't hold.
//
// Run it: `npm run example:checkout`

const CHECKOUTS = 5;

async function main(): Promise<number> {
	const failures: string[] = [];
	const assert = (condition: boolean, message: string): void => {
		if (!condition) failures.push(message);
	};

	const [payments, inventory, shipping] = await Promise.all([
		startPaymentsStub(),
		startInventoryStub(),
		startShippingStub(),
	]);

	const metrics = createInMemoryMetrics();
	const app = await createCheckoutApp({
		inventoryUrl: inventory.url,
		paymentsUrl: payments.url,
		paymentsHost: payments.host,
		shippingUrl: shipping.url,
		metrics,
	});

	let retryCount = 0;
	app.client.on("retry", ({ partition, attempt, delayMs, error }) => {
		retryCount++;
		console.log(
			`  [retry] partition=${partition} attempt=${attempt} delayMs=${delayMs} error=${error.constructor.name}`,
		);
	});

	let circuitOpenPartition: string | undefined;
	app.client.on("circuitOpen", ({ partition }) => {
		circuitOpenPartition = partition;
		console.log(`  [circuit] OPEN partition=${partition}`);
	});

	console.log(`payments stub:   ${payments.url} (always 503)`);
	console.log(`inventory stub:  ${inventory.url} (always 200)`);
	console.log(`shipping stub:   ${shipping.url} (always 200)`);
	console.log(`checkout app:    ${app.url}`);
	console.log();

	for (let i = 0; i < CHECKOUTS; i++) {
		const sku = `sku-${i}`;
		const response = await fetch(`${app.url}/checkout`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ sku, amount: 1999 }),
		});
		const outcome = (await response.json()) as {
			inventory: { ok: boolean; status?: number; error?: string };
			payment: { ok: boolean; status?: number; error?: string };
			shipping: { ok: boolean; status?: number; error?: string };
		};
		console.log(
			`checkout #${i + 1} (${sku}): ` +
				`inventory=${outcome.inventory.ok ? `OK(${outcome.inventory.status})` : `FAIL(${outcome.inventory.error})`}, ` +
				`payment=${outcome.payment.ok ? `OK(${outcome.payment.status})` : `FAIL(${outcome.payment.error})`}, ` +
				`shipping=${outcome.shipping.ok ? `OK(${outcome.shipping.status})` : `FAIL(${outcome.shipping.error})`}`,
		);
	}
	console.log();

	// ---------------------------------------------------------------------
	// The same story, as your dashboards would see it: every metric is
	// tagged with its partition, so one bad dependency stands out on its own.
	// ---------------------------------------------------------------------

	console.log(
		formatMetricsTable(metrics, {
			[inventory.host]: "inventory",
			[payments.host]: "payments",
			[shipping.host]: "shipping",
		}),
	);
	console.log();

	// ---------------------------------------------------------------------
	// Verify the claims — instanceof against the raw Result objects kept
	// in-process, never against a JSON-serialized error kind.
	// ---------------------------------------------------------------------

	assert(app.log.length === CHECKOUTS, `expected ${CHECKOUTS} checkout records, got ${app.log.length}`);

	for (const record of app.log) {
		assert(record.inventory.success === true, `inventory call for ${record.sku} did not succeed`);
		assert(record.shipping.success === true, `shipping call for ${record.sku} did not succeed`);
	}

	// The circuit breaker (failureThreshold: 4, 2 attempts per checkout) trips
	// partway through the second checkout: the first two checkouts each
	// exhaust their retries against the live stub, then every checkout after
	// that is rejected by the open breaker before it ever reaches payments.
	const tripIndex = app.log.findIndex(
		(record) => !record.payment.success && record.payment.error instanceof CircuitOpenError,
	);
	assert(tripIndex !== -1, "circuit breaker never tripped — no payment failed with CircuitOpenError");

	const preTrip = tripIndex === -1 ? app.log : app.log.slice(0, tripIndex);
	const postTrip = tripIndex === -1 ? [] : app.log.slice(tripIndex);

	for (const record of preTrip) {
		assert(
			!record.payment.success && record.payment.error instanceof MaxRetriesExceededError,
			`expected payment for ${record.sku} (pre-trip) to fail with MaxRetriesExceededError, got ${
				record.payment.success ? "success" : record.payment.error.constructor.name
			}`,
		);
	}
	for (const record of postTrip) {
		assert(
			!record.payment.success && record.payment.error instanceof CircuitOpenError,
			`expected payment for ${record.sku} (post-trip) to fail with CircuitOpenError, got ${
				record.payment.success ? "success" : record.payment.error.constructor.name
			}`,
		);
	}

	assert(retryCount > 0, "expected at least one retry event on the payments partition");
	assert(
		circuitOpenPartition === payments.host,
		`expected circuitOpen for partition ${payments.host}, got ${circuitOpenPartition}`,
	);

	// The whole point: once the breaker is open, rejected payment attempts
	// never reach the stub. Two pre-trip checkouts each make 2 attempts
	// (initial + 1 retry) against the live stub — 4 hits — and nothing after.
	assert(payments.hits() === 4, `expected exactly 4 requests to reach the payments stub, got ${payments.hits()}`);

	// And the metrics tell the same story, attributed to the right dependency:
	// every request counted, but retries and breaker trips only on payments.
	const stats = (host: string) => metrics.byPartition.get(host);
	for (const [name, host] of [
		["inventory", inventory.host],
		["payments", payments.host],
		["shipping", shipping.host],
	] as const) {
		assert(
			stats(host)?.requests === CHECKOUTS,
			`expected ${CHECKOUTS} requests metered for ${name}, got ${stats(host)?.requests}`,
		);
		assert(stats(host)?.durationsMs.length === CHECKOUTS, `expected ${CHECKOUTS} durations metered for ${name}`);
	}
	assert(
		stats(payments.host)?.retries === retryCount,
		`expected the payments partition's retry metric to match the ${retryCount} retry events`,
	);
	assert(
		stats(payments.host)?.circuitOpen === 1,
		"expected exactly one circuit_open metric, on the payments partition",
	);
	for (const host of [inventory.host, shipping.host]) {
		assert(
			stats(host)?.retries === 0 && stats(host)?.circuitOpen === 0,
			`expected no retries or breaker trips metered for ${host}`,
		);
	}

	console.log(failures.length === 0 ? "All claims verified." : `${failures.length} claim(s) failed:`);
	for (const failure of failures) {
		console.log(`  - ${failure}`);
	}

	// ---------------------------------------------------------------------
	// Shutdown — drain (everything is already settled by now), then force
	// every server's sockets closed so no keep-alive connection is left
	// holding the process open.
	// ---------------------------------------------------------------------

	await app.client.close({ drain: true, timeoutMs: 2_000 });
	await Promise.all([app.close(), payments.close(), inventory.close(), shipping.close()]);

	return failures.length === 0 ? 0 : 1;
}

main()
	.then((exitCode) => {
		process.exitCode = exitCode;
	})
	.catch((err: unknown) => {
		console.error("checkout example crashed:", err);
		process.exitCode = 1;
	});
