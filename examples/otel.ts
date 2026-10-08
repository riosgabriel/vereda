import { metrics, trace } from "@opentelemetry/api";
import { HttpClient } from "@vereda/http";
import { instrumentTracing, otelMetricsSink } from "@vereda/http/otel";

// ---------------------------------------------------------------------------
// Example: wiring vereda into OpenTelemetry with @vereda/http/otel
// ---------------------------------------------------------------------------
//
// Register an OpenTelemetry SDK (tracer and meter providers, a propagator and
// exporters) the usual way before this runs. Without one, `trace` and
// `metrics` hand back no-op implementations, so this example runs as-is and
// simply records nothing.

async function main() {
	const client = HttpClient.create({
		baseUrl: "https://httpbin.org",
		timeout: { attemptMs: 5_000 },
		retry: { maxRetries: 1 },
		metrics: otelMetricsSink(metrics.getMeter("vereda-example")),
	});

	// Register after any client.use() middleware of your own, so each attempt
	// span times the request itself and traceparent is injected last.
	const stop = instrumentTracing(client, { tracer: trace.getTracer("vereda-example") });

	const result = await client.get("/get").toPromise();
	console.log(result.success ? `Status: ${result.raw.status}` : `Error: ${result.error.kind}`);

	stop();
	await client.close();
}

// Only run if executed directly (not imported)
if (process.argv[1] === import.meta.filename) {
	main().catch(console.error);
}
