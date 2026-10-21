# Getting started

Install Vereda, send a first request, and learn which defaults you get.

Vereda needs Node.js 22 or later, Bun, or Cloudflare Workers. It is ESM only, ships its TypeScript types, and has zero runtime dependencies.

## Install

```bash
npm install @vereda/http
# or
bun add @vereda/http
# or
pnpm add @vereda/http
```

## Your first request

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

`toPromise()` never rejects: every outcome is a `Result`, and every failure is one of Vereda's own error classes, discriminated by `kind` ([Error handling](results-and-errors.md#error-handling)). `json<T>()` casts without checking, so pass a real validator, or use the [Zod adapter](results-and-errors.md#zod-adapter-optional), when you need the shape enforced.

`timeout.attemptMs` is the one required setting. Most HTTP clients have no overall request timeout by default, which is how one hung dependency takes a service down. Vereda makes you choose a number, or pass `Infinity` to opt out on purpose.

## What you get by default

Everything else has a default. The most important ones:

| Setting | Default |
| --- | --- |
| Retries | 3 retries after the first attempt (4 total executions) |
| Backoff | Exponential: 200ms base, 30s cap, full jitter |
| Retry-on status codes | `[408, 425, 429, 500, 502, 503, 504]` |
| Per-partition concurrency | 5 retries in flight per host |
| Total deadline | None; set `timeout.totalMs` to cap the whole request |
| Circuit breaker | Disabled; opt in with `circuitBreaker: { enabled: true }` |

The [README](../../README.md#quick-start) has the full table, including queue sizes, the retry budget and rate limiting.

## Where next

- [Working with requests](requests.md): cancellation, middleware and custom fetch.
- [Results and errors](results-and-errors.md): typed bodies, validation and the error kinds.
- [Resilience](resilience.md): retries, timeouts, bulkheads and the circuit breaker.
- [Observability](observability.md): lifecycle events, metrics and OpenTelemetry.
- [Operations](../operations.md): tuning and running Vereda in production.
- [Patterns](https://vereda.dev/patterns/): each resilience pattern animated, with and without it, on the same traffic.
- [API reference](https://vereda.dev/api/): every export, option and type.
