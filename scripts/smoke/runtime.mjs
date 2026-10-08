// Runtime smoke test for the built package: imports dist/ and drives requests
// through retry, events, ids, cancellation and the total deadline. It uses
// only web-standard APIs and an injected fetch (no server), so the same file
// runs on every runtime a host script loads it into.
// One import per package entry point ("." "./middleware" "./zod" "./otel"),
// so a non-portable import in any of them fails here. The OTel entry also
// loads its optional peer, @opentelemetry/api.
import { metrics, trace } from "@opentelemetry/api";
import { withZod } from "../../dist/adapters/zod.js";
import { CancelledError, DeadlineExceededError, HttpClient } from "../../dist/core/index.js";
import { defaultHeaders } from "../../dist/middleware/index.js";
import { instrumentTracing, otelMetricsSink } from "../../dist/otel/index.js";

/** First call per path answers 503, later calls 200 `{ ok: true }`; `/hang`
 *  never answers and rejects once the attempt's signal aborts. Records the
 *  `x-smoke` header each call carried. */
function fakeFetch(headersSeen) {
	const seen = new Set();
	return (input, init) => {
		const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
		headersSeen.push(new Headers(init?.headers).get("x-smoke"));
		if (path === "/hang") {
			return new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal.reason)));
		}
		if (!seen.has(path)) {
			seen.add(path);
			return Promise.resolve(new Response("busy", { status: 503 }));
		}
		return Promise.resolve(Response.json({ ok: true }));
	};
}

export async function smoke() {
	const headersSeen = [];
	const client = HttpClient.create({
		baseUrl: "http://smoke.test",
		fetch: fakeFetch(headersSeen),
		// No SDK is registered, so these are OTel's no-op meter and tracer:
		// enough to run the adapters' code paths without exporting anything.
		metrics: otelMetricsSink(metrics.getMeter("smoke")),
		timeout: { attemptMs: 2_000 },
		retry: { backoff: { baseDelayMs: 10, jitter: false } },
	});
	client.use(defaultHeaders({ "x-smoke": "1" }));
	instrumentTracing(client, { tracer: trace.getTracer("smoke") });
	const events = [];
	for (const name of ["request", "retry", "success", "failure", "cancelled"]) {
		client.on(name, () => events.push(name));
	}

	// A stand-in for a Zod schema: withZod only needs `.parse`.
	const schema = {
		parse(data) {
			if (data?.ok !== true) throw new Error("bad body");
			return data;
		},
	};
	const ok = await client.get("/flaky", { parse: withZod(schema) }).toPromise();
	assert(ok.success, `retry then success, got ${ok.success ? "success" : ok.error.kind}`);
	assert(ok.data.ok === true, "parsed JSON body through withZod");
	assert(headersSeen.length === 2 && headersSeen.every((h) => h === "1"), "defaultHeaders middleware ran");

	const ticket = client.get("/hang");
	assert(/^[\w-]{21}$/.test(ticket.id), `ticket id looks like a nanoid: ${ticket.id}`);
	ticket.cancel();
	const cancelled = await ticket.toPromise();
	assert(!cancelled.success && cancelled.error instanceof CancelledError, "cancel resolves CancelledError");

	const late = await client.get("/hang", { timeout: { totalMs: 50 } }).toPromise();
	assert(!late.success && late.error instanceof DeadlineExceededError, "totalMs resolves DeadlineExceededError");

	await client.close();
	// Counts, not order: a cancelled ticket's events land asynchronously.
	const expected = ["cancelled", "failure", "request", "request", "request", "retry", "success"];
	assert(JSON.stringify(events.sort()) === JSON.stringify(expected), `events: ${events.join(",")}`);
}

function assert(condition, message) {
	if (!condition) throw new Error(`smoke: ${message}`);
}
