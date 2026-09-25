import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { HttpClient, type MetricsSink, type Result } from "vereda";

// ---------------------------------------------------------------------------
// The checkout app
// ---------------------------------------------------------------------------
//
// A tiny `node:http` server exposing `POST /checkout`. It calls three
// downstream dependencies — inventory, payments, shipping — through a single
// `HttpClient`, exactly like a real checkout service would. Payments is the
// one dependency the driver (index.ts) points at a stub that always answers
// 503, to show that Vereda's per-host bulkhead and circuit breaker keep that
// failure from touching inventory or shipping traffic.

export interface CheckoutDeps {
	inventoryUrl: string;
	paymentsUrl: string;
	/** `new URL(paymentsUrl).host` — the partition key the payments requests
	 *  land in, needed here only to scope the payments partition's config. */
	paymentsHost: string;
	shippingUrl: string;
	/** Where the client reports its metrics (requests, retries, latency,
	 *  breaker trips — each tagged with the partition it belongs to). */
	metrics?: MetricsSink;
}

/** The raw, un-serialized outcome of one checkout — kept in memory (never
 *  sent over the wire) so the driver can assert on real `AppError` instances
 *  with `instanceof` instead of a JSON-serialized stand-in. */
export interface CheckoutRecord {
	sku: string;
	inventory: Result<unknown>;
	payment: Result<unknown>;
	shipping: Result<unknown>;
}

export interface CheckoutApp {
	client: HttpClient;
	url: string;
	/** Every checkout handled so far, in order. Read-only from the outside. */
	log: readonly CheckoutRecord[];
	close: () => Promise<void>;
}

export function createCheckoutApp(deps: CheckoutDeps): Promise<CheckoutApp> {
	const client = HttpClient.create({
		// Generous for a demo talking to localhost stubs that answer instantly;
		// a production client would tune this per dependency. totalMs caps each
		// request, retries included — it must exceed attempts × attemptMs
		// (default 3 retries = 4 × 2s here) or it would cut off a legitimate retry.
		timeout: { attemptMs: 2_000, totalMs: 10_000 },
		metrics: deps.metrics,
		partitions: {
			[deps.paymentsHost]: {
				// Small on purpose — this is the partition we want to watch fill
				// up and trip, not one sized for real production traffic.
				concurrency: 2,
				maxQueueSize: 5,
				retry: {
					maxRetries: 1,
					// Tiny, non-jittered backoff so the whole demo finishes in well
					// under 5s. A production policy would use larger, jittered
					// delays — see the README's default (200ms base, 30s cap, jitter on).
					backoff: { baseDelayMs: 10, maxDelayMs: 20, jitter: false },
				},
				circuitBreaker: {
					enabled: true,
					failureThreshold: 4,
					// Kept short so the demo can prove the breaker trips and stays
					// open without waiting around. The README's own example uses
					// resetTimeoutMs: 30_000 for production traffic.
					resetTimeoutMs: 1_500,
				},
			},
		},
	});

	const log: CheckoutRecord[] = [];

	async function handleCheckout(sku: string, amount: number): Promise<CheckoutRecord> {
		// All three dependencies are called on every checkout — that's the
		// point: a payments outage must never slow down or block inventory or
		// shipping, which run in their own bulkhead partitions.
		const [inventory, payment, shipping] = await Promise.all([
			client.get(`${deps.inventoryUrl}/stock/${sku}`).toPromise(),
			// POST is not idempotent by default — an Idempotency-Key header is
			// what makes Vereda willing to retry it (see the README's retry
			// policy section).
			client
				.post(`${deps.paymentsUrl}/charge`, JSON.stringify({ sku, amount }), {
					headers: { "Content-Type": "application/json", "Idempotency-Key": randomUUID() },
				})
				.toPromise(),
			client.get(`${deps.shippingUrl}/quote/${sku}`).toPromise(),
		]);

		const record: CheckoutRecord = { sku, inventory, payment, shipping };
		log.push(record);
		return record;
	}

	const server = createServer((req, res) => {
		if (req.method !== "POST" || req.url !== "/checkout") {
			res.writeHead(404, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "not found" }));
			return;
		}

		let body = "";
		req.on("data", (chunk: Buffer) => {
			body += chunk;
		});
		req.on("end", () => {
			void (async () => {
				try {
					const { sku, amount } = JSON.parse(body || "{}") as { sku?: string; amount?: number };
					const record = await handleCheckout(sku ?? "sku-unknown", amount ?? 0);
					res.writeHead(200, { "Content-Type": "application/json" });
					res.end(
						JSON.stringify({
							sku: record.sku,
							inventory: summarize(record.inventory),
							payment: summarize(record.payment),
							shipping: summarize(record.shipping),
						}),
					);
				} catch (err) {
					res.writeHead(500, { "Content-Type": "application/json" });
					res.end(JSON.stringify({ error: err instanceof Error ? err.message : "internal error" }));
				}
			})();
		});
	});

	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (address === null || typeof address === "string") {
				throw new Error("checkout server did not bind to a TCP port");
			}
			resolve({
				client,
				log,
				url: `http://127.0.0.1:${address.port}`,
				close: () =>
					new Promise((r) => {
						// Force-close any lingering keep-alive sockets so the process
						// can exit immediately instead of waiting out the client's
						// idle timeout.
						server.closeAllConnections();
						server.close(() => r());
					}),
			});
		});
	});
}

/** Human-readable, JSON-safe outcome for the HTTP response — display only.
 *  `error.constructor.name` (not `.kind`) is used here purely for a readable
 *  label; the driver's actual pass/fail assertions run against the raw
 *  `CheckoutRecord.log` with `instanceof`. */
function summarize(result: Result<unknown>): { ok: boolean; status?: number; error?: string } {
	if (result.success) {
		return { ok: true, status: result.raw.status };
	}
	return { ok: false, error: `${result.error.constructor.name}: ${result.error.message}` };
}
