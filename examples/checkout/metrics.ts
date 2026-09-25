import { METRICS, type MetricsSink, type MetricTags } from "vereda";

// ---------------------------------------------------------------------------
// An in-memory metrics sink
// ---------------------------------------------------------------------------
//
// `MetricsSink` is three methods — counter, histogram, gauge — each given a
// metric name, a value, and tags. This one just keeps counters and histogram
// samples in memory, keyed by the `partition` tag, so the driver can print a
// per-dependency table at the end. In production you'd forward the same calls
// to OpenTelemetry, StatsD, Prometheus… — see examples/otel.ts for an adapter.

export interface PartitionStats {
	requests: number;
	retries: number;
	circuitOpen: number;
	durationsMs: number[];
}

export interface InMemoryMetrics extends MetricsSink {
	/** Stats per `partition` tag value (the host, unless overridden). */
	byPartition: ReadonlyMap<string, PartitionStats>;
}

export function createInMemoryMetrics(): InMemoryMetrics {
	const byPartition = new Map<string, PartitionStats>();
	const statsFor = (tags?: MetricTags): PartitionStats | undefined => {
		const partition = tags?.partition;
		if (partition === undefined) return undefined; // e.g. in_flight, global_queue_depth
		let stats = byPartition.get(partition);
		if (!stats) {
			stats = { requests: 0, retries: 0, circuitOpen: 0, durationsMs: [] };
			byPartition.set(partition, stats);
		}
		return stats;
	};

	return {
		byPartition,
		counter(name, value, tags) {
			const stats = statsFor(tags);
			if (!stats) return;
			if (name === METRICS.REQUESTS) stats.requests += value;
			else if (name === METRICS.RETRIES) stats.retries += value;
			else if (name === METRICS.CIRCUIT_OPEN) stats.circuitOpen += value;
		},
		histogram(name, value, tags) {
			if (name === METRICS.DURATION) statsFor(tags)?.durationsMs.push(value);
		},
		gauge() {
			// Point-in-time gauges (in-flight, queue depth) aren't part of this summary.
		},
	};
}

/** Render one row per partition. `labels` maps a partition (host) to a readable
 *  dependency name, since the demo's stubs listen on ephemeral ports. */
export function formatMetricsTable(metrics: InMemoryMetrics, labels: Record<string, string>): string {
	const header = ["dependency", "requests", "retries", "p50 ms", "max ms", "circuit_open"];
	const rows = [...metrics.byPartition].map(([partition, s]) => {
		const sorted = [...s.durationsMs].sort((a, b) => a - b);
		const p50 = sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)] : 0;
		const max = sorted.length ? sorted[sorted.length - 1] : 0;
		return [labels[partition] ?? partition, s.requests, s.retries, p50, max, s.circuitOpen].map(String);
	});
	const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
	const line = (cells: string[]) =>
		cells.map((c, i) => (i === 0 ? c.padEnd(widths[i]) : c.padStart(widths[i]))).join("  ");
	return [line(header), ...rows.map(line)].join("\n");
}
