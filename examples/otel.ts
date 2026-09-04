import { HttpClient, type MetricsSink, type MetricTags } from "../src/core/index.js";

// ---------------------------------------------------------------------------
// Example: wiring vereda metrics into OpenTelemetry
// ---------------------------------------------------------------------------

/**
 * Adapts vereda's MetricsSink to OpenTelemetry meters.
 *
 * Usage:
 *   import { metrics } from "@opentelemetry/api"
 *   const sink = createOtelMetricsSink(metrics)
 *   const client = HttpClient.create({ metrics: sink })
 */
export function createOtelMetricsSink(otelMeter?: {
	createCounter: (
		name: string,
		opts?: { description?: string },
	) => {
		add: (value: number, attrs?: Record<string, string>) => void;
	};
	createHistogram: (
		name: string,
		opts?: { description?: string; unit?: string },
	) => {
		record: (value: number, attrs?: Record<string, string>) => void;
	};
	createObservableGauge: (
		name: string,
		opts?: { description?: string },
	) => {
		addCallback: (cb: (gauge: { observe: (attrs?: Record<string, string>) => number }) => void) => void;
	};
}): MetricsSink {
	if (!otelMeter) {
		// Return a no-op sink if no meter is provided
		return {
			counter() {},
			histogram() {},
			gauge() {},
		};
	}

	const requestCounter = otelMeter.createCounter("vereda.requests", {
		description: "Total vereda requests initiated",
	});
	const retryCounter = otelMeter.createCounter("vereda.retries", {
		description: "Total vereda retries executed",
	});
	const durationHistogram = otelMeter.createHistogram("vereda.duration_ms", {
		description: "Request duration in milliseconds",
		unit: "ms",
	});

	return {
		counter(name: string, value: number, tags?: MetricTags) {
			if (name === "vereda.requests") {
				requestCounter.add(value, tags);
			} else if (name === "vereda.retries") {
				retryCounter.add(value, tags);
			}
		},
		histogram(name: string, value: number, tags?: MetricTags) {
			if (name === "vereda.duration_ms") {
				durationHistogram.record(value, tags);
			}
		},
		gauge(_name: string, _value: number, _tags?: MetricTags) {
			// Gauges (in_flight, queue_depth) require observable gauges in OTel,
			// which need a callback registration pattern — skipped for simplicity.
		},
	};
}

// ---------------------------------------------------------------------------
// Minimal usage example
// ---------------------------------------------------------------------------

async function main() {
	const sink: MetricsSink = {
		counter(name, value, tags) {
			console.log(`[counter] ${name} +${value}`, tags);
		},
		histogram(name, value, tags) {
			console.log(`[histogram] ${name} ${value}ms`, tags);
		},
		gauge(name, value, tags) {
			console.log(`[gauge] ${name} = ${value}`, tags);
		},
	};

	const client = HttpClient.create({
		baseUrl: "https://httpbin.org",
		metrics: sink,
		retry: { maxRetries: 1 },
	});

	const result = await client.get("/get").toPromise();
	if (result.success) {
		console.log("Status:", result.data.status);
	} else {
		console.error("Error:", result.error.kind);
	}

	await client.close();
}

// Only run if executed directly (not imported)
if (process.argv[1] === import.meta.filename) {
	main().catch(console.error);
}
