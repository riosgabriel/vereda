// ---------------------------------------------------------------------------
// Metrics sink — pluggable observability (O2)
// ---------------------------------------------------------------------------

/** Tags attached to every metric emission. All values are strings so that
 *  callers can use whatever cardinality they need. */
export type MetricTags = Record<string, string>

/** Pluggable sink for vereda metrics. Implement this interface to wire
 *  vereda into OpenTelemetry, Prometheus, Datadog, or any other metrics
 *  backend. The client calls these methods at well-defined lifecycle points;
 *  all calls are synchronous and non-blocking. */
export interface MetricsSink {
  /** Monotonically increasing counter (e.g. total requests, total retries). */
  counter(name: string, value: number, tags?: MetricTags): void
  /** Latency distribution (e.g. request duration in ms). */
  histogram(name: string, value: number, tags?: MetricTags): void
  /** Point-in-time gauge (e.g. current in-flight requests, queue depth). */
  gauge(name: string, value: number, tags?: MetricTags): void
}

// ---------------------------------------------------------------------------
// Standard metric names
// ---------------------------------------------------------------------------

export const METRICS = {
  /** Total requests initiated. Tags: partition, method. */
  REQUESTS: "vereda.requests",
  /** Total retries executed. Tags: partition, kind. */
  RETRIES: "vereda.retries",
  /** Request duration in ms (histogram). Tags: partition, kind, status. */
  DURATION: "vereda.duration_ms",
  /** Current queue depth per partition. Tags: partition. */
  QUEUE_DEPTH: "vereda.queue_depth",
  /** Current in-flight requests across all partitions. */
  IN_FLIGHT: "vereda.in_flight",
} as const
