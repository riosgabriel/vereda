<p align="center">
  <img src="assets/logo.png" alt="Vereda" width="200" />
</p>

<h1 align="center">Vereda</h1>

<h3 align="center">Make <code>fetch</code> resilient.</h3>

<p align="center">
  Retries, backoff, timeouts, per-host isolation, and circuit breaking for Node.js <code>fetch</code> — with typed results instead of thrown errors.
</p>

<p align="center">
  <a href="https://github.com/riosgabriel/vereda/actions/workflows/ci.yml"><img src="https://github.com/riosgabriel/vereda/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="https://github.com/riosgabriel/vereda/blob/main/LICENSE"><img src="https://img.shields.io/github/license/riosgabriel/vereda" alt="License" /></a>
  <a href="https://nodejs.org/en/about/previous-releases"><img src="https://img.shields.io/badge/node-22%2B-green" alt="Node 22+" /></a>
  <a href="https://github.com/riosgabriel/vereda"><img src="https://img.shields.io/badge/ESM-only-blue" alt="ESM only" /></a>
  <a href="https://github.com/riosgabriel/vereda"><img src="https://img.shields.io/badge/TypeScript-6.0-blue" alt="TypeScript" /></a>
  <a href="https://github.com/riosgabriel/vereda/blob/main/package.json"><img src="https://img.shields.io/badge/dependencies-0-brightgreen" alt="Zero runtime dependencies" /></a>
</p>

```typescript
import { HttpClient } from "@vereda/http";

const api = HttpClient.create({
  baseUrl: "https://api.example.com",
  timeout: { attemptMs: 5_000 },
});

const result = await api.get("/users/42").toPromise(); // never rejects

if (result.success) {
  const user = await result.raw.json();
} else {
  console.error(result.error.kind, result.error.message); // a typed error
}
```

A dropped connection, a timeout, or a `503` on that request is retried up to three times with jittered exponential backoff before your code sees an error. Reading `result.raw` afterwards is bounded too: the body read has to finish within the same `attemptMs` (counted from when the attempt started) and `totalMs` limits, or the read rejects with Vereda's own `TimeoutError` (attempt bound) or `DeadlineExceededError` (`totalMs` bound).

## Why Vereda?

`fetch` makes one attempt. Everything after that is yours to write:

```typescript
async function getUser(id: string) {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(`https://api.example.com/users/${id}`, {
        signal: AbortSignal.timeout(5_000),
      });
      if (res.ok) return await res.json();
      throw new Error(`HTTP ${res.status}`); // 404 or 503? retry both?
    } catch (err) {
      // timeout, DNS failure, or the throw above? caught all the same
      // is this request safe to repeat? what if it were a POST?
      if (attempt === 3) throw err;
    }
    await new Promise((r) => setTimeout(r, 200 * 2 ** attempt)); // jitter? Retry-After?
  }
}
```

Even once that loop is correct, it has no limit on how many retries pile onto a struggling host, no way to cancel, and callers that can only tell a `404` from a timeout by parsing an error message. Vereda is that loop written carefully, once:

| When… | Vereda… |
| --- | --- |
| A request fails transiently (connection reset, timeout, `408`, `425`, `429`, `500`, `502`–`504`) | retries it with exponential backoff and full jitter, honoring `Retry-After` |
| A retry could duplicate a side effect | retries only idempotent methods unless you opt in or send an `Idempotency-Key` |
| A request hangs | aborts each attempt at `timeout.attemptMs`; an optional `timeout.totalMs` caps the whole request |
| One failing host would soak up your retries | caps retry concurrency and queue size per host, so one host's retries can't fill another's queue (all hosts still share the global `concurrency` cap) |
| A host is down, not just slow | an opt-in circuit breaker fails fast with `CircuitOpenError` until it recovers |
| The response isn't the shape you expected | validates it with your `parse` function (or Zod); a failed parse is never retried |
| The caller no longer needs the answer | cancels via the ticket or your `AbortSignal`; a cancelled request is never retried |
| You need to know what happened | emits typed lifecycle events (with attempt counts and queue time) and [metrics](docs/guide/observability.md#metrics) (requests, retries, latency, in-flight, queue depth, breaker trips), tagged per partition |
| You need auth headers, logging, URL rewriting | runs onion middleware around every attempt |

**What Vereda does not do.** No response caching, no request deduplication, no streaming helpers, no browser support. It targets Node.js 22+ services that depend on other services; for a handful of calls in a script, plain `fetch` is fine.

## Quick start

```bash
npm install @vereda/http
```

```typescript
import { HttpClient, json } from "@vereda/http";

type User = { id: number; name: string };

const api = HttpClient.create({
  baseUrl: "https://api.example.com",
  timeout: { attemptMs: 5_000 },
});

const result = await api.get("/users/42", { parse: json<User>() }).toPromise();

if (result.success) {
  result.data.name; // typed: string
} else {
  switch (result.error.kind) {
    case "http": // non-retryable status, e.g. 404
      console.warn(result.error.statusCode);
      break;
    case "max_retries": // transient failures outlasted every retry
      console.error(result.error.lastError);
      break;
    default:
      console.error(result.error.message);
  }
}
```

`toPromise()` never rejects: every outcome is a `Result`, and every failure is one of a closed set of error classes, discriminated by `kind` ([Error handling](docs/guide/results-and-errors.md#error-handling)). `json<T>()` casts without checking; pass a real validator, or use the [Zod adapter](docs/guide/results-and-errors.md#zod-adapter-optional), when you need the shape enforced.

**`timeout.attemptMs` is the one required setting.** Most HTTP clients have no overall request timeout by default, which is how one hung dependency takes a service down. Vereda makes you choose a number, or pass `Infinity` to opt out on purpose. Everything else has a default:

| Setting | Default |
| --- | --- |
| Retries | 3 retries after the first attempt (4 total executions) |
| Backoff | Exponential: 200ms base, 30s cap, full jitter |
| Retry-on status codes | `[408, 425, 429, 500, 502, 503, 504]` |
| Per-partition concurrency | 5 retries in flight per host |
| Per-partition queue size | 100 waiting retries per host |
| Global concurrency | 50 in-flight executions across all partitions |
| Global queue size | 100 waiting executions; beyond that a request resolves with `QueueFullError` (`partition: "global"`) |
| First attempts | Skip the per-partition bulkhead (unless `partition.limitFirstAttempts` is set), but still take a global permit |
| Total deadline | None — set `timeout.totalMs` to cap the whole request |
| Circuit breaker | Disabled — opt in with `circuitBreaker: { enabled: true }` |

## Example: one failing dependency

A checkout service calls three hosts. The payment provider starts returning `503`.

```typescript
import { HttpClient } from "@vereda/http";

const client = HttpClient.create({
  timeout: { attemptMs: 3_000, totalMs: 15_000 },
  partitions: {
    "payments.example.com": {
      concurrency: 2,
      maxQueueSize: 20,
      circuitBreaker: { enabled: true, failureThreshold: 5, resetTimeoutMs: 30_000 },
    },
  },
});

// POST isn't retried by default; the idempotency key tells Vereda a repeat is safe.
const charge = client.post("https://payments.example.com/charges", JSON.stringify(order), {
  headers: { "Content-Type": "application/json", "Idempotency-Key": order.id },
});
```

```
checkout service
  │
  ├──► payments.example.com    503, 503, 503 …
  │      retries: at most 2 in flight, 20 waiting, the rest fail fast with QueueFullError
  │      after 5 straight failures: circuit opens, calls fail instantly with CircuitOpenError
  │      after 30s: one trial request; success closes the circuit
  │
  ├──► inventory.example.com   own partition: its retries aren't queued behind payments'
  └──► shipping.example.com    own partition: same
```

Every request is assigned to a partition by host, and each partition has its own retry queue and its own breaker. Payments' retries are capped at 2 in flight, and once its breaker opens, payment calls stop reaching the network, apart from the half-open trial and any retry that had already passed the breaker check before its backoff. The `totalMs` deadline means no single call waits longer than 15 seconds, retries included.

One limit is shared: every attempt, first attempts included, takes a permit from the client-wide `concurrency` cap (default 50, with 100 waiting). A host that fails *slowly* holds those permits while it hangs, so under enough load it can delay or reject requests to healthy hosts. Keep `attemptMs` short for dependencies that tend to hang, and set `limitFirstAttempts: true` on a partition to put its fresh traffic behind its own bulkhead too.

[`examples/checkout/`](examples/checkout/) is this scenario as a runnable app: stub upstreams on localhost, a small checkout server, and a driver that asserts the retries and the breaker tripping while inventory and shipping keep succeeding (sequential traffic and smaller numbers, so it runs fast; it doesn't exercise the queue limits). Clone the repo and run `npm run example:checkout`.

It ends by printing what a dashboard fed from Vereda's [metrics](docs/guide/observability.md#metrics) would show for that run. Every metric is tagged with its partition, so the failing dependency is easy to pick out:

```
dependency  requests  retries  p50 ms  max ms  circuit_open
inventory          5        0       3       8             0
payments           5        2       1      21             1
shipping           5        0       3       7             0
```

Note payments' low median latency, despite the outage: once its breaker opened, its calls were rejected on the spot instead of waiting on a failing host.

## How it works

```
client.get(url)
      │
      ▼
 breaker check ─> global permit ─> first attempt
                                        │
      ┌────────────────────────────────►┤ outcome of each attempt
      │                                 ├─ success ─────────────────> done
      │                                 ├─ non-retryable or vetoed ─> resolves with that error
      │                                 ├─ transient, none left ────> MaxRetriesExceededError
      │                                 └─ transient, retries left
      │                                          │
      │   breaker check ─> backoff ─> partition bulkhead ─> global permit ─> retry
      │                                (per host)                             │
      └───────────────────────────────────────────────────────────────────────┘
```

The first attempt skips the partition bulkhead. Only requests that need another attempt go through their partition's queue, so a host's retry backlog waits in its own partition queue, not ahead of other hosts' retries. Once admitted, a retry still needs a permit from the global `concurrency` cap, which it waits for alongside fresh requests. When the circuit breaker is enabled, it is checked before the first attempt and again before every retry.

## Features

| | | |
| --- | --- | --- |
| **[Retries and backoff](docs/guide/resilience.md#retries-and-backoff)**<br>Jittered exponential retries for transient failures | **[Timeouts](docs/guide/resilience.md#timeouts)**<br>Per-attempt timeout plus an optional total deadline | **[Bulkhead isolation](docs/guide/resilience.md#bulkhead-isolation)**<br>A concurrency limit and queue per host |
| **[Circuit breaker](docs/guide/resilience.md#circuit-breaker)**<br>Stop calling a host that is clearly failing | **[Cancellation](docs/guide/requests.md#cancellation)**<br>Cancel from the ticket or an `AbortSignal` | **[Tickets](docs/guide/requests.md#tickets)**<br>Await, subscribe to, or cancel a request |
| **[Typed results](docs/guide/results-and-errors.md#typed-results)**<br>Validate the body with any `parse` function | **[Error handling](docs/guide/results-and-errors.md#error-handling)**<br>A closed error hierarchy with a literal `kind` | **[Middleware](docs/guide/requests.md#middleware)**<br>Onion-style hooks around every attempt |
| **[Custom fetch](docs/guide/requests.md#custom-fetch)**<br>Swap `globalThis.fetch` for your own | **[Lifecycle events](docs/guide/observability.md#lifecycle-events)**<br>Typed client-wide events for logging | **[Metrics](docs/guide/observability.md#metrics)**<br>Counters, histograms and gauges to any sink |
| **[OpenTelemetry](docs/guide/observability.md#opentelemetry)**<br>Spans per ticket and attempt, plus an OTel metrics sink | | |

Each card links into one of four guides: [Resilience](docs/guide/resilience.md) · [Results and errors](docs/guide/results-and-errors.md) · [Working with requests](docs/guide/requests.md) · [Observability](docs/guide/observability.md).

## Design philosophy

**Fresh traffic comes first.** The first attempt skips the partition bulkhead, which exists to throttle *retry* pressure onto struggling hosts — that's where thundering herds come from.

**Backpressure beats unbounded queues.** When a queue is full, fail explicitly rather than consuming infinite memory.

**Cancellation is final.** A cancelled request never enters the retry loop, regardless of timeout or retry configuration.

**Validation failures aren't transient.** A response that fails your `parse` function resolves immediately — retrying would parse the same payload again.

**No silent infinite waits.** The per-attempt timeout is the one setting without a default, because a missing timeout is the failure you only find in production.

## Documentation

- **Feature guides** — [Resilience](docs/guide/resilience.md) (retries, timeouts, bulkheads, circuit breaker) · [Results and errors](docs/guide/results-and-errors.md) · [Working with requests](docs/guide/requests.md) (cancellation, tickets, middleware, custom fetch) · [Observability](docs/guide/observability.md) (events, metrics, OpenTelemetry).
- **[Operations guide](docs/operations.md)** — sizing concurrency and queues, `attemptMs` vs. `totalMs`, reading `partitions()` and `circuits()`, wiring a metrics sink, the shutdown sequence, and log redaction.
- **[API reference](https://riosgabriel.github.io/vereda/)** — generated from source via TypeDoc on every push to `main`; every public option documents its default.

## Versioning and support

Vereda follows [Semantic Versioning](https://semver.org/) from `1.0.0` onward: breaking changes land only in a major version, and anything scheduled for removal is deprecated in a minor release first and noted in [CHANGELOG.md](CHANGELOG.md) before it goes. The public surface is exactly what `src/core/index.ts`, `src/middleware/index.ts`, `src/adapters/zod.ts`, and `src/otel/index.ts` export — anything under `src/queue/` and `src/ticket/` that those entry points don't re-export is internal, even though it's readable source.

**Node support:** the currently supported line is whatever `engines.node` in `package.json` declares (`>=22` today); CI runs the full suite against Node 22 and 24 on every change, so those two are the versions actually verified. The floor moves only in a major release.

**Other runtimes:** the library imports no Node builtins and uses only web-standard APIs (`fetch`, `AbortController`, `crypto.getRandomValues`, timers). Each row below says how that's checked:

| Runtime | Status | How it's verified |
| --- | --- | --- |
| Node 22, 24 | Supported | Full test suite in CI |
| Bun | Supported | Full test suite in CI |
| Cloudflare Workers | Supported, no `nodejs_compat` needed | CI smoke test loads the built package into workerd and drives every entry point ([`scripts/smoke/workers.mjs`](scripts/smoke/workers.mjs)) |
| Deno | Expected to work | Manual smoke test (`deno run scripts/smoke/deno.mjs`); not in CI |
| Browsers | Expected to work | Not tested |

## Contributing

New to Vereda? Two on-ramps:

- **Self-guided** — read [ONBOARDING.md](ONBOARDING.md), a tour that follows one request through the library.
- **Interactive** — run the **`guide-me`** skill in your coding harness (Claude Code, OpenCode, etc.). It's bundled in the repo and walks you through the internals interactively.

When you're ready, read [CONTRIBUTING.md](CONTRIBUTING.md) for setup, commands, and the behavioral invariants your change must preserve. Tests are self-contained: no network, services, or env vars needed.

## Why the name?

**Vereda** is Brazilian Portuguese for a narrow trail: a resilient route through terrain. That maps directly to what the library does: give your requests a reliable path through flaky networks, retries, and backpressure. *veh-REH-da.*

## License

MIT
