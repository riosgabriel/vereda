# 10. Observability and extension points

> **Crux:** How does information leave the client, and how can user code plug in without being able to break it?

A resilience library you can't see into is a liability. When a dependency degrades, you need to
know which host is being retried, which circuit breaker opened, and how long requests are
waiting in queues. So Vereda reports what it does through several channels, and it lets your
code plug in at a few points along the way.

Both directions share one danger: every channel runs *your* code in the middle of a request.
A listener, a metrics sink or a logger can have a bug.

This chapter keeps coming back to one rule: **your code can watch an outcome, but it must never
change it.** A listener that throws must not turn a success into a failure, and a URL with a token
in it must not leak into a log.

The user-facing reference is [docs/guide/observability.md](../guide/observability.md) and
[docs/guide/requests.md](../guide/requests.md). This chapter is about how they're built.

## What our request tells the world

Take the running example, the request for user 42 that hangs, then gets a 503, then works, and
switch everything on: event listeners, a metrics sink, a logger, the request-logging
middleware and OpenTelemetry tracing. Add `?token=abc` to the path so redaction has something
to do. This is what comes out, one line per call, condensed:

| ms | Source | Call | Detail |
| --- | --- | --- | --- |
| 3 | event | `request` |  |
| 3 | metric | `vereda.requests +1` | `{partition: api.example.com, method: GET}` |
| 3 | metric | `vereda.in_flight = 1` |  |
| 3 | metric | `vereda.queue_depth = 0` | `{partition: api.example.com}` |
| 3 | metric | `vereda.global_queue_depth = 0` |  |
| 3 | logger | `info  Request initiated` |  |
| 207 | middleware | `Request failed` | url `…/users/42?token=[redacted]`, 192 ms |
| 209 | logger | `info  Request queued for retry` |  |
| 211 | event | `retry` |  |
| 211 | metric | `vereda.retries +1` | `{kind: timeout}` |
| 256 | middleware | `Request completed` | status 503, 7 ms |
| 257 | event | `retry` |  |
| 257 | metric | `vereda.retries +1` | `{kind: retryable_status}` |
| 401 | middleware | `Request completed` | status 200, 2 ms |
| 403 | metric | `vereda.in_flight = 0` |  |
| 403 | event | `success` |  |
| 404 | metric | `vereda.duration_ms 402` | `{partition: api.example.com, kind: success}` |
| 404 | metric | `vereda.queue_depth = 0` |  |
| 404 | metric | `vereda.global_queue_depth = 0` |  |

When the request finishes, the tracer holds four spans: one for the whole request, carrying two
`vereda.retry` span events, and one child span per try.

The channels split into two groups:

| Out: information leaves the client | In: your code plugs in |
| --- | --- |
| lifecycle events (`client.on`) | middleware (`client.use`) |
| ticket updates (`ticket.on`, chapter 4) | `parse` functions |
| a metrics sink | the `fetch` implementation |
| a logger | |
| snapshots (`partitions()`, `circuits()`, chapters 8 and 9) | |

Three things in that output are worth predicting before you read on. Why does the logger say
nothing when the request succeeds? Why does `in_flight` drop to 0 *before* the `success` event?
And why does the middleware log three lines when every other channel talks about one request?
Each section below answers one.

## Lifecycle events

Events are the complete record. Every other channel is built from them or sits next to them.
They're declared as a type map in `src/core/types.ts`:

| Event | When | How often per request |
| --- | --- | --- |
| `request` | the URL resolved and the checks passed | at most once |
| `retry` | a retry is about to wait; `delayMs` is the whole wait, a `Retry-After` pause included | 0 or more |
| `success`, `failure`, `cancelled` | the ticket settles | exactly one of the three |
| `retryBudgetExhausted` | the budget refused a retry; a `failure` follows | 0 or 1 |
| `circuitOpen`, `circuitClose` | a host's breaker changes state | per host, not per request |

Every payload carries the ticket's id, the redacted URL and the partition. The three ending
events add the number of attempts, the total duration and the time spent queueing. Our request's
`success` said `attempts: 3`.

The partition can be missing on two events. A `failure` has none when the URL never resolved,
because the partition *is* the URL's host.

A `cancelled` has none in one rare case: a request whose abort signal had already fired before you
made the call, *and* whose URL can't be resolved. That request ends before it ever starts, and the
client doesn't invent a host for it.

> **Aside: the pre-aborted request.** If you pass a signal that's already aborted, the ticket is
> cancelled inside `send` (chapter 5), before the first attempt runs. Until #196, the first
> attempt didn't notice: if that request also failed an early check, it emitted `failure` for a
> ticket whose result was already "cancelled", which broke the one-ending-event rule. Now the
> first attempt checks for a settled ticket before anything else, emits a single `cancelled`,
> and returns. A side effect worth knowing: such a request never emits `request`.

### One door out

All of these events leave through a single private method. Here it is, with its comment:

`src/core/client.ts` — `emit`
```typescript
/** Never throws: listener and metrics-sink errors are isolated (B3), since
 *  callers emit mid-transition — e.g. `success` right before `markDone`. */
private emit<K extends keyof LifecycleEventMap>(event: K, data: LifecycleEventMap[K]): void {
	this.emitter.emit(event, data);
	try {
		this.emitMetrics(event, data);
	} catch (err) {
		reportCallbackError(err);
	}
}
```

The comment says why this method may never throw. Think back to chapter 5: when our request's
first try succeeds, the client emits `success` and *then* settles the ticket.

If a listener's error escaped here, the settle line would never run. The error would land in the
safety net behind the first attempt, and you'd get a network failure, plus a second, contradictory
`failure` event, for a request that worked.

So errors from your code are caught in two places. The emitter from chapter 4 catches each
listener's error separately, so one broken listener doesn't silence the others.

The metrics call is wrapped here. Both hand the error to the same small function, described in the
design note at the end: it rethrows the error later, outside the request's path.

> **Aside: bug B3.** That success-turned-failure is not hypothetical. It's bug B3 from the 1.0
> review, and the reason the comment names it. B2 was its twin on the ticket side: a throwing
> ticket listener could leave `toPromise()` waiting forever.

## Metrics

A metrics sink is an object with three methods, `counter`, `histogram` and `gauge`, each taking
a name, a number and some string tags. It lives in `src/core/metrics.ts`, and the names are
constants there, all starting with `vereda.`. The client calls the sink from `emitMetrics`,
which turns each event into metrics:

| Event | Metrics |
| --- | --- |
| `request` | requests counter, in-flight gauge, queue-depth gauges |
| `retry` | retries counter, tagged with the kind of error that caused it |
| `success`, `failure`, `cancelled` | duration histogram, tagged with the outcome; queue-depth gauges |
| `circuitOpen` | circuit-open counter |
| `retryBudgetExhausted` | budget-exhausted counter |

> **User 42:** The two retries were tagged `timeout` and `retryable_status`, the kinds from chapter 7.

That tag is what lets a dashboard tell "the host is slow" from "the host is failing".

Two choices in this code were bugs once, and one is new.

**In-flight is reported where the ticket leaves.** That's why our output shows
`vereda.in_flight = 0` before `event success`. The gauge isn't sampled when the ending event
fires.

The gauge is reported by the ticket's cleanup function from chapter 5, at the moment the ticket
leaves the in-flight set. On the retry path, cleanup runs before the event, so the gauge comes
first. The rule behind this, in the words of `AGENTS.md`: "Sample state where it changes."

> **Aside: bug B15.** The gauge used to be sampled at emit time. The first-attempt path emits
> *then* cleans up, while the retry loop cleans up *then* emits, so a client whose requests all
> succeeded on the first try reported one request in flight while it sat idle (#149).

**Queue depth is polled, not pushed.** The queue-depth gauges are read only at `request` and at
the ending events. The method's own comment admits the gap: a request that's queued and
released between two of those moments "can land on neither poll and never register".

Trust the gauges for a sustained backlog, not a brief one. The per-request queueing time on the
events has no such gap, because it's measured on every wait.

**A missing partition is a missing tag.** When an ending event has no partition, the duration
histogram leaves the partition tag off entirely rather than sending a made-up value. A
metrics backend sees a series without that tag, which is honest: there was no host.

## The logger

`ClientConfig.logger` is the simplest channel: an object with `debug`, `info`, `warn` and
`error`. The client calls it from four places, and only four:

| Level | Message | When |
| --- | --- | --- |
| info | Request initiated | after the `request` event |
| info | Request succeeded | the *first* try succeeded |
| info | Request queued for retry | the first try failed and a retry will follow |
| warn | Request failed after retries | the retry loop ended in failure |

That answers the first puzzle.

> **User 42:** The request succeeded on its third try, and no line covers that
> case, so the logger said "initiated" and "queued for retry" and then nothing.

A request that
fails on its first try, say with a 404, gets only "initiated". The logger is a partial record.
If you need every ending, listen to the events.

### A logger can't break a request

The logger runs user code mid-request, just like a listener, so it gets the same protection.
Every call goes through one private method:

`src/core/client.ts` — `log`
```typescript
/** Never throws: a throwing `logger` must not change a request's outcome,
 *  its events or its retries (B3), so its error is reported like a
 *  listener's instead of unwinding through the request path. */
private log(level: "info" | "warn", msg: string, meta: Record<string, unknown>): void {
	try {
		this.logger?.[level](msg, meta);
	} catch (err) {
		reportCallbackError(err);
	}
}
```

It has the same shape as `emit`: call the user's code, catch, report the error elsewhere. If a
logger throws while logging "Request queued for retry" for our request, the request still makes
its three tries and still succeeds. The error shows up on its own, a moment later.

> **Aside: the last unguarded callback.** Until #200, the four log calls were plain method calls.
> A logger that threw on "Request succeeded" turned a successful response into a failure with
> both `success` and `failure` events, exactly bug B3 again, through a door the B3 fix hadn't
> covered (issue #197). The fix added `log` and updated the invariant in `AGENTS.md` to name the
> logger alongside listeners and sinks.

## Redaction

URLs often carry secrets: `?api_key=…`, or `https://user:pass@host`. Our request's token never
appears in the output above, because everything the client emits, logs or puts in an error
message goes through one method:

`src/core/client.ts` — `logUrl`
```typescript
private logUrl(url: string): string {
	return this.redactQuery ? redactUrl(url) : url;
}
```

`redactUrl`, in `src/core/redact.ts`, replaces the username and password with `[redacted]@` and
every query *value* with `[redacted]`, keeping the keys. So
`https://bob:hunter2@api.example.com/auth?token=abc123` becomes
`https://[redacted]@api.example.com/auth?token=[redacted]`. It's done with string matching, not
by parsing the URL, so it works on relative URLs and can't throw.

The first attempt computes this display URL once and passes it everywhere: to the retry loop,
to each attempt, and so into timeout and deadline error messages. That's the "two URLs" rule
from chapter 5: the full URL is fetched, the display URL is shown.

> **Aside: bug B5.** Before #88, several paths used the raw URL, so a timeout's error message
> could carry a token straight into your error tracker.

Redaction has two limits. First, the client's `redactQuery: false` option affects only the
client's own output. The request-logging middleware and the tracing module can't see the
client's config, so each has its own `redactQuery` option, and both always strip credentials
whatever you set.

Second, Vereda redacts only what *it* emits. The URL inside an HTTP error's
response object, or a URL your own middleware logs, is yours to protect. `redactUrl` is exported
for that.

## Middleware helpers

Middleware (chapter 6) wraps each *try*, not the whole request. That's the answer to the third
puzzle: the middleware logged three lines because our request made three tries.
`src/middleware/index.ts` has two ready-made pieces:

- `defaultHeaders` sets each header only if the request doesn't already have it. The comparison
  ignores case, so a request's own `authorization` beats a default `Authorization`.
- `requestLogger` logs the URL, status and duration of each try, with redaction on by default.
  Our first try shows up as "Request failed" with the abort message, because the attempt timer
  aborted it while the middleware was waiting.

The request logger takes a `log` function from you, which raises the same question as the
client's logger. Here the stakes are higher.

Middleware runs *inside* the try, so an error thrown after a response arrived would count as a
failed try: the client would retry it and send the request again. So the logger wraps your function
the same way:

`src/middleware/index.ts` — `requestLogger`
```typescript
const sink = options?.log ?? ((msg, meta) => console.log(msg, meta));
// A throwing sink must not fail (or get retried) a request, B3.
const log = (msg: string, meta: Record<string, unknown>): void => {
	try {
		sink(msg, meta);
	} catch (err) {
		reportCallbackError(err);
	}
};
```

The default sink is `console.log`, which the project's lint rules normally forbid, so that line
carries a comment telling Biome it's intended. `AGENTS.md` warns that running Biome's unsafe
fixes on this file silently turns the default logger into a no-op.

## The Zod adapter

The `parse` option (chapter 3) accepts any function from unknown data to your type. Zod gets a
one-line helper because it's common, and `src/adapters/zod.ts` is the whole thing:

`src/adapters/zod.ts` — `withZod`
```typescript
export function withZod<T>(schema: ZodType<T>): ParseFn<T> {
	return (data: unknown): Promise<T> => schema.parseAsync(data);
}
```

Using the async parse means schemas with async checks work. When validation fails, the attempt
code copies Zod's list of issues onto the `ValidationError`, so you can see which field was
wrong. Any other validator works the same way without an adapter. This file is the only one
allowed to import `zod` (chapter 2).

## OpenTelemetry

`src/otel/index.ts` is built entirely from the public pieces you've just met: events, middleware
and the metrics sink. That makes it a good example of what the extension points can do.

**Tracing.** `instrumentTracing(client, { tracer })` creates two kinds of span. For our request:

- **One request span**, started on the `request` event and kept in a map by ticket id. Each
  `retry` event adds a span event to it (our two), and the ending event closes it with the
  attempt count, 3, and the status code. A cancelled request's span gets no error status:
  "Cancellation is the caller's choice, not a failure."
- **One span per try**, made by a middleware. It finds the request span by ticket id, starts a
  child span under it, marks retries with the try number, and injects a `traceparent` header so
  the downstream service joins the same trace. Our three child spans record a timeout, a 503
  and a 200. When a try throws, the span records only the error's *name*, because "messages can
  carry an unredacted URL".

A request that never emitted `request`, like the pre-aborted one from earlier, has no span in
the map. When its `cancelled` event arrives, the closing function finds nothing and returns
quietly:

`src/otel/index.ts` — `instrumentTracing` (the `end` helper)
```typescript
const end = (ticketId: string, attempts: number, finish: (span: Span) => void) => {
	const span = tickets.get(ticketId);
	if (!span) return;
	tickets.delete(ticketId);
	span.setAttribute("vereda.attempts", attempts);
	finish(span);
	span.end();
};
```

Because the per-try span is middleware, and the last middleware registered runs closest to
`fetch` (chapter 6), the docs tell you to call `instrumentTracing` after your own middleware, so
the span times only the network call.

`instrumentTracing` returns a stop function. Middleware can't be removed from a client, so stopping
flips a flag that turns the middleware into a pass-through, removes the event listeners and ends any
open spans.

**Metrics.** `otelMetricsSink(meter)` is a metrics sink on top of an OpenTelemetry meter. It
creates each instrument the first time a name appears, so a new Vereda metric needs no change
here. It marks histograms whose name ends in `_ms` as milliseconds, and it turns gauges into
observable gauges that report the latest value for each set of tags.

Only this file may import `@opentelemetry/api`. Users who don't import the `/otel` entry point
never load it.

## Design note: rethrow on a microtask

When your code throws inside one of these channels, the client has three choices: swallow the
error, let it propagate, or report it somewhere else. `reportCallbackError`, in
`src/core/listeners.ts`, picks the third, and its comment says why: "Swallowing it would hide the
bug; letting it propagate synchronously would abort whatever state transition was in progress."

So it rethrows the error on a fresh microtask:

`src/core/listeners.ts` — `reportCallbackError`
```typescript
export function reportCallbackError(err: unknown): void {
	queueMicrotask(() => {
		throw err;
	});
}
```

By the time that microtask runs, the request's state change has finished. The error reaches
`process.on("uncaughtException")`, which the comment calls "the same contract as
`node:diagnostics_channel` subscribers". The cost is real: by default, an uncaught exception
crashes a Node process. The project chose that on purpose. A bug in your listener is loud, but
it can't corrupt a request.

Every callback in this chapter now goes through this function: listeners, the metrics sink, the
client's logger and the request logger's sink. If you add a new kind of callback, route it here
too. The logger's history shows what happens when one door is left unguarded.

## What must stay true

- Every lifecycle event and metrics call goes through `emit`, and every logger call through
  `log`. Errors from user code are rethrown on a microtask, never into the request's path.
- Each request emits exactly one ending event, and it matches the ticket's result. A request
  cancelled before it started emits `cancelled` and nothing else.
- Every URL that leaves the client (events, logs, error messages) is the redacted display URL.
  The request logger and the tracing spans always strip credentials.
- The in-flight gauge is reported when a ticket leaves the in-flight set, not when an event
  fires.
- A metric with no partition omits the tag; it never invents one.
- Only `src/otel/index.ts` imports `@opentelemetry/api`, and only `src/adapters/zod.ts` imports
  `zod`.

## Try it

Start from the running example in the README. Keep the `setInterval` line: Vereda's timers
don't keep Node alive.

1. **Predict, then run.** Give the client a logger whose `info` throws when the message is
   "Request queued for retry". Before you run it, decide: does the request still succeed, and
   how many times is the server called? Then add
   `process.on("uncaughtException", (e) => console.log("uncaught:", e.message))` and run it.
   (The request succeeds after 3 calls, with the usual `request`, `retry`, `retry`, `success`
   events. The logger's error arrives separately as an uncaught exception. Remove the handler
   and run again: Node now crashes, but only after the error is rethrown, not inside the
   request.)
2. **Predict, then run.** Use a fake server that always answers 404 and a logger that records
   every call. Which lines are logged? (Only "Request initiated". A 404 isn't retried, and no
   log line covers a failure on the first try.)
3. **Predict, then run.** Pass a signal that's already aborted:
   `const ac = new AbortController(); ac.abort();` then `api.get("/users/42", { signal: ac.signal })`.
   Which events fire, how many times is the server called, and what does the metrics sink see?
   (One `cancelled` event, no `request`, zero calls to the server. The sink gets a duration
   histogram tagged `kind: cancelled`, plus gauges. Now drop the `baseUrl` from the client and
   repeat: the `cancelled` event's partition is `undefined`, and the histogram has no partition
   tag at all.)
4. **Read the tests.** Open `test/core/callback-isolation.test.ts`. It has three groups: ticket
   listeners, client listeners and metrics, and the logger. In the logger group, find the test
   about the request logger's sink. What does it count to prove the request wasn't sent twice?
5. **Change + test.** Write a middleware that adds `X-Request-Id: <ticketId>` to every try, and a
   test that the same id arrives on each try of one request. Copy patterns from
   `test/middleware/index.test.ts`.
