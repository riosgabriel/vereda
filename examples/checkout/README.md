# Checkout example: one failing dependency

A checkout service calls three downstream dependencies — inventory, payments,
shipping — through a single Vereda `HttpClient`. Payments is down (always
returns 503). This example shows what Vereda does about it:

- the first couple of checkouts each exhaust their retries against payments
  and fail with `MaxRetriesExceededError`;
- once enough consecutive failures accumulate, the payments partition's
  circuit breaker trips open (`circuitOpen`), and every checkout after that
  fails immediately with `CircuitOpenError` — no request reaches the stub;
- inventory and shipping, on their own hosts/partitions, keep succeeding the
  whole time. A failing dependency never touches the others.

It ends by printing the run as a metrics dashboard would see it, one row
per partition:

```
dependency  requests  retries  p50 ms  max ms  circuit_open
inventory          5        0       3       8             0
payments           5        2       1      21             1
shipping           5        0       3       7             0
```

(Timings vary from run to run.) Retries and the breaker trip show up only on
payments, and its median latency stays low despite the outage, because once
the breaker opened those calls failed instantly.

## Layout

- `stubs.ts` — three `node:http` servers on `127.0.0.1` ephemeral ports:
  payments (always 503), inventory and shipping (always 200). No network.
- `app.ts` — the checkout app itself: a `node:http` server exposing
  `POST /checkout`, backed by one `HttpClient` with a small `concurrency`/
  `maxQueueSize` and an enabled `circuitBreaker` on the payments partition,
  reporting to the metrics sink it's given.
- `metrics.ts` — a small in-memory `MetricsSink` that groups counters and
  durations by their `partition` tag, plus the table printer. It shows how
  little a sink takes; `examples/otel.ts` is the production-shaped version.
- `index.ts` — the driver and entry point. Starts everything in-process,
  fires a handful of checkouts at the real HTTP endpoint, prints what
  happened, then asserts the claims above and exits non-zero if any fail.

## Run it

```bash
npm run example:checkout
```

Finishes in well under a second — the retry backoff and circuit breaker
`resetTimeoutMs` are configured with tiny values so the demo doesn't sit
around waiting (a comment in `app.ts` notes what production-sized values
would look like, e.g. the README's `resetTimeoutMs: 30_000`).

## What it asserts

After the checkouts run, the driver checks (via `instanceof` against the raw
`Result` objects it keeps in-process — never against a JSON-serialized error
label):

- every inventory and shipping call succeeded;
- the circuit breaker tripped at least once, evidenced by a payment call
  failing with `CircuitOpenError`;
- every payment failure before the trip is a `MaxRetriesExceededError`, and
  every one after is a `CircuitOpenError`;
- at least one `retry` lifecycle event fired on the payments partition;
- the payments stub received exactly as many requests as the pre-trip
  retries account for — proving that once the breaker is open, rejected
  requests never reach the server.
- the metrics agree, per partition: every dependency meters one request and
  one duration per checkout, the payments partition's retry count matches
  the `retry` events, and `circuit_open` fires exactly once, on payments.
  Inventory and shipping meter no retries and no trips.

Any failed assertion is printed and the process exits with code 1.
