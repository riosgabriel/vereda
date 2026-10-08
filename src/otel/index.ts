import {
	type Attributes,
	context,
	type Meter,
	type ObservableGauge,
	propagation,
	type Span,
	SpanKind,
	SpanStatusCode,
	type TextMapSetter,
	type Tracer,
	trace,
} from "@opentelemetry/api";
import type { HttpClient } from "../core/client.ts";
import type { MetricsSink, MetricTags } from "../core/metrics.ts";
import { redactUrl, redactUserinfo } from "../core/redact.ts";
import type { LifecycleEventMap } from "../core/types.ts";
import type { MiddlewareFn } from "../queue/executor.ts";

// ---------------------------------------------------------------------------
// Tracing
// ---------------------------------------------------------------------------

export interface OtelTracingOptions {
	/** Tracer the spans are created with, e.g. `trace.getTracer("my-service")`. */
	tracer: Tracer;
	/** Inject the active trace context (`traceparent`, through the globally
	 *  registered propagator) into each attempt's request headers, so the
	 *  downstream service joins the trace.
	 *  @default true */
	propagate?: boolean;
	/** Replace query parameter values in `url.full` with `[redacted]`.
	 *  Credentials in the URL (`user:pass@`) are always redacted.
	 *  @default true */
	redactQuery?: boolean;
}

const headersSetter: TextMapSetter<Headers> = {
	set(carrier, key, value) {
		carrier.set(key, value);
	},
};

/**
 * Traces every request the client makes: one `INTERNAL` span per ticket,
 * covering queueing, every attempt and backoff, with one `CLIENT` child span
 * per attempt (`http.request.resend_count` is the retry number). Attributes
 * follow the OpenTelemetry HTTP semantic conventions.
 *
 * Call it after your own `client.use()` middleware: the attempt span is
 * registered as middleware, and the last one registered runs closest to
 * `fetch`, so it times the request itself and injects headers last.
 *
 * Returns a function that stops recording. The middleware stays registered
 * (middleware can't be removed) but becomes a pass-through.
 *
 * @example
 * import { trace } from "@opentelemetry/api";
 * const stop = instrumentTracing(client, { tracer: trace.getTracer("checkout") });
 */
export function instrumentTracing(client: HttpClient, options: OtelTracingOptions): () => void {
	const { tracer, propagate = true } = options;
	const safeUrl = options.redactQuery === false ? redactUserinfo : redactUrl;
	const tickets = new Map<string, Span>();
	let active = true;

	const onRequest = (e: LifecycleEventMap["request"]) => {
		const span = tracer.startSpan(`vereda ${e.method}`, {
			kind: SpanKind.INTERNAL,
			attributes: {
				"http.request.method": e.method,
				"url.full": safeUrl(e.url),
				"vereda.ticket_id": e.ticketId,
				"vereda.partition": e.partition,
			},
		});
		tickets.set(e.ticketId, span);
	};

	const onRetry = (e: LifecycleEventMap["retry"]) => {
		tickets.get(e.ticketId)?.addEvent("vereda.retry", {
			"vereda.retry.attempt": e.attempt,
			"vereda.retry.delay_ms": e.delayMs,
			"error.type": e.error.kind,
		});
	};

	const end = (ticketId: string, attempts: number, finish: (span: Span) => void) => {
		const span = tickets.get(ticketId);
		if (!span) return;
		tickets.delete(ticketId);
		span.setAttribute("vereda.attempts", attempts);
		finish(span);
		span.end();
	};

	const onSuccess = (e: LifecycleEventMap["success"]) =>
		end(e.ticketId, e.attempts, (span) => {
			span.setAttribute("http.response.status_code", e.statusCode);
		});

	const onFailure = (e: LifecycleEventMap["failure"]) =>
		end(e.ticketId, e.attempts, (span) => {
			span.setAttribute("error.type", e.error.kind);
			span.setStatus({ code: SpanStatusCode.ERROR, message: e.error.kind });
		});

	// Cancellation is the caller's choice, not a failure: status stays unset.
	const onCancelled = (e: LifecycleEventMap["cancelled"]) =>
		end(e.ticketId, e.attempts, (span) => {
			span.setAttribute("vereda.cancelled", true);
		});

	const attemptSpans: MiddlewareFn = async (ctx, next) => {
		if (!active) return next(ctx);

		const parent = tickets.get(ctx.ticketId);
		const parentContext = parent ? trace.setSpan(context.active(), parent) : context.active();
		const attributes: Attributes = {
			"http.request.method": ctx.method,
			"url.full": safeUrl(ctx.url),
			"vereda.partition": ctx.partition,
		};
		if (ctx.attempt > 0) attributes["http.request.resend_count"] = ctx.attempt;
		const span = tracer.startSpan(ctx.method, { kind: SpanKind.CLIENT, attributes }, parentContext);
		if (propagate) propagation.inject(trace.setSpan(parentContext, span), ctx.headers, headersSetter);

		try {
			const response = await next(ctx);
			span.setAttribute("http.response.status_code", response.status);
			if (response.status >= 400) {
				span.setAttribute("error.type", String(response.status));
				span.setStatus({ code: SpanStatusCode.ERROR });
			}
			return response;
		} catch (err) {
			// Only the error's name: messages can carry an unredacted URL.
			span.setAttribute("error.type", err instanceof Error ? err.name : "unknown");
			span.setStatus({ code: SpanStatusCode.ERROR });
			throw err;
		} finally {
			span.end();
		}
	};

	client.on("request", onRequest);
	client.on("retry", onRetry);
	client.on("success", onSuccess);
	client.on("failure", onFailure);
	client.on("cancelled", onCancelled);
	client.use(attemptSpans);

	return () => {
		active = false;
		client.off("request", onRequest);
		client.off("retry", onRetry);
		client.off("success", onSuccess);
		client.off("failure", onFailure);
		client.off("cancelled", onCancelled);
		for (const span of tickets.values()) span.end();
		tickets.clear();
	};
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

/**
 * A `MetricsSink` that records vereda's metrics (see `METRICS`) on an
 * OpenTelemetry meter: counters as counters, `vereda.duration_ms` as a
 * histogram in ms, and gauges as observable gauges reporting the latest
 * value per tag set. Instruments are created on first use, so new vereda
 * metrics are recorded without changes here.
 *
 * @example
 * import { metrics } from "@opentelemetry/api";
 * const client = HttpClient.create({
 *   timeout: { attemptMs: 5_000 },
 *   metrics: otelMetricsSink(metrics.getMeter("checkout")),
 * });
 */
export function otelMetricsSink(meter: Meter): MetricsSink {
	const counters = new Map<string, ReturnType<Meter["createCounter"]>>();
	const histograms = new Map<string, ReturnType<Meter["createHistogram"]>>();
	const gauges = new Map<string, { gauge: ObservableGauge; latest: Map<string, [number, MetricTags | undefined]> }>();

	return {
		counter(name, value, tags) {
			let counter = counters.get(name);
			if (!counter) {
				counter = meter.createCounter(name);
				counters.set(name, counter);
			}
			counter.add(value, tags);
		},
		histogram(name, value, tags) {
			let histogram = histograms.get(name);
			if (!histogram) {
				histogram = meter.createHistogram(name, name.endsWith("_ms") ? { unit: "ms" } : undefined);
				histograms.set(name, histogram);
			}
			histogram.record(value, tags);
		},
		gauge(name, value, tags) {
			let entry = gauges.get(name);
			if (!entry) {
				const latest = new Map<string, [number, MetricTags | undefined]>();
				const gauge = meter.createObservableGauge(name);
				gauge.addCallback((result) => {
					for (const [observed, observedTags] of latest.values()) result.observe(observed, observedTags);
				});
				entry = { gauge, latest };
				gauges.set(name, entry);
			}
			entry.latest.set(tagKey(tags), [value, tags]);
		},
	};
}

/** Stable key for a tag set, independent of property order. */
function tagKey(tags: MetricTags | undefined): string {
	if (!tags) return "";
	return JSON.stringify(Object.entries(tags).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}
