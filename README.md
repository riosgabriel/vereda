# Relay

A resilient HTTP client for Node.js. Configure retries, timeouts, and per-host concurrency limits once on the client, then make requests. Relay fires each request, absorbs failures, backs off, and retries. You await one result.

Every request returns a **Ticket** — a handle you can await, subscribe to, or cancel while Relay does the work.

```typescript
import { HttpClient } from "relay";

const client = HttpClient.create({ baseUrl: "https://api.example.com" });

const result = await client.get("/users/1").toPromise();
if (result.success) {
  const user = await result.raw.json();
} else {
  console.error(result.error.message); // typed error, never a throw
}
```

## Status

Relay is early-stage software. The API is small, tested (36 passing tests), and MIT licensed, but it has not been hardened in production yet. Pin the version you depend on.

## Why Relay

`fetch` gives you one attempt at a request. Production code needs more: retry flaky networks, back off when a server returns 429, cap how many calls hit a struggling host, and give up cleanly when a request hangs. Most codebases grow a tangle of `setTimeout`, `try/catch`, and ad-hoc queues around `fetch` to get there.

Relay puts that machinery in one place:

- **Retries with exponential backoff and jitter**, on by default for every failed request
- **Bulkhead isolation** — each host gets its own concurrency limit and queue, so one failing upstream can't starve the rest
- **Timeouts** that cancel slow requests and hand them to the retry loop
- **A result type instead of exceptions** — requests resolve to `{ success, data, raw }` or `{ success: false, error }` with typed error classes
- **Observability** — lifecycle events and per-ticket status updates for anything you need to monitor

Relay is built on Node's global `fetch` and `node:events`. It runs on Node 18+ and is ESM-only. It is not a browser client.

## Installation

Relay is not published to npm yet. The `relay` name on npm belongs to an unrelated package — don't install that one.

Install from GitHub instead:

```bash
npm install github:riosgabriel/relay
```

npm runs the build during install (via the `prepare` script), so `dist/` is ready when installation finishes.

## How a request flows

```
client.get(url)
      |
      v
 first attempt ------ success ------> ticket done
      |
 failure, timeout, or busy status (e.g. 429)
      |
      v
 partition bulkhead --> backoff --> retry --> ... --> done
      (per host)                      |
                                      +-- attempts exhausted --> MaxRetriesExceededError
```

The first attempt fires immediately, outside the bulkhead. Only requests that need another attempt go through their partition's queue, which is what keeps retry traffic from hammering an already-struggling host.

With zero configuration:

| Setting | Default |
| --- | --- |
| Global concurrency | 10 in-flight retries across all partitions |
| Per-partition concurrency | 5 |
| Per-partition queue size | 100 waiting requests |
| Retries | 3 retries after the first attempt (4 total executions) |
| Backoff | Exponential: 200ms base, 30s cap, full jitter |
| Timeout | None |
| Queue-on status codes | None (all non-2xx responses are retried as errors) |

A request is retried on any failure: network errors, non-2xx responses, timeouts, and any status code you list in `queueOnStatus`. The one exception is schema validation — a response that fails your `parse` function resolves immediately with a `ValidationError`, because retrying would parse the same payload again.

## Tickets

`client.get()` and friends return synchronously with a `Ticket<T>`. The ticket tracks the request from first attempt to terminal result:

```typescript
const ticket = client.get("/api/data");

ticket.status;      // { state: "pending" | "queued" | "retrying" | "done" | "cancelled" }
ticket.id;          // unique ticket id
ticket.isCancelled; // boolean

// Await the terminal result
const result = await ticket.toPromise();

// Or follow every state change
for await (const update of ticket.subscribe()) {
  // { type: "queued" }
  // { type: "retrying", attempt, delayMs }
  // { type: "done", result }
  // { type: "cancelled" }
}

// Or use events
ticket.on("done", (result) => {});
ticket.on("error", (error) => {});
ticket.on("update", (update) => {});
```

`toPromise()` never rejects. The result is a discriminated union:

```typescript
type Result<T> =
  | { success: true; data: T; raw: Response }
  | { success: false; error: AppError };
```

One detail worth knowing: without a `parse` function, `data` is `undefined` and the unparsed body lives on `result.raw` (the standard `Response` object). Add a `parse` function to get typed `data` — see [Schema validation](#schema-validation).

## Retries and backoff

Configure retries globally, per partition, or per request. Per-request settings override partition settings, which override global ones.

```typescript
const client = HttpClient.create({
  retry: {
    maxAttempts: 5, // retries after the first attempt
    backoff: {
      baseDelayMs: 1000, // first retry delay before jitter
      maxDelayMs: 30000, // cap
      jitter: true,      // full jitter: uniform random in [0, delay]
    },
  },
});
```

The default backoff is `200ms * 2^attempt`, capped at 30s, with full jitter applied. Jitter spreads retries out so a fleet of clients doesn't hit a recovering server at the same instant.

You can also supply a custom backoff function, where `attempt` is the zero-based retry number:

```typescript
retry: {
  maxAttempts: 3,
  backoff: (attempt) => Math.min(100 * 2 ** attempt, 10000),
}
```

### Deciding which failures to retry

`retryWhen` is consulted after every failed attempt — including the first one, before any retry is scheduled. Return `false` to surface the error immediately.

```typescript
import { NetworkError } from "relay";

retry: {
  maxAttempts: 5,
  retryWhen: (error, attempt) => {
    // error: the AppError from the attempt that just failed
    // attempt: that attempt's zero-based number (0 = first attempt)
    if (error instanceof NetworkError && error.statusCode === 500) return false;
    return true;
  },
}
```

When all attempts are exhausted, the ticket resolves with a `MaxRetriesExceededError` carrying the attempt count and the last underlying error.

## Partitions and bulkheads

Every request is assigned to a partition, keyed by hostname by default. Each partition owns a bulkhead: a concurrency limit plus a waiting queue. A slow or failing host fills its own queue and throttles its own retries without touching traffic to other hosts.

```typescript
const client = HttpClient.create({
  concurrency: 10, // global cap across all partitions

  partitions: {
    "api.external.com": {
      concurrency: 2,    // at most 2 in-flight retries
      maxQueueSize: 10,  // at most 10 waiting requests
    },
    "api.internal.com": {
      concurrency: 20,
    },
  },
});
```

Partitions are created on first use. You can also assign a partition explicitly, which is useful for priority lanes or for grouping several hosts:

```typescript
client.get("/path", { partition: "high-priority" });
```

When a partition's queue is full, the new request's ticket resolves with a `NetworkError` explaining the queue is full. That is deliberate backpressure: the alternative is unbounded memory growth.

## Timeouts and queue triggers

```typescript
const client = HttpClient.create({
  trigger: {
    timeoutMs: 5000,           // cancel attempts slower than 5s and retry them
    queueOnStatus: [429, 503], // treat these statuses as "busy, try again later"
  },
});
```

- `timeoutMs` — a hard per-attempt timeout. The attempt is aborted and the request joins the retry loop. No timeout is set by default.
- `queueOnStatus` — status codes that mean the server is busy rather than broken. Matching responses are queued for retry without being treated as errors. 429 and 503 are the usual candidates.

Both settings merge per request, same as retry config:

```typescript
client.get("/api/data", {
  trigger: { timeoutMs: 10000, queueOnStatus: [429, 500, 502, 503, 504] },
});
```

## Middleware

Middleware wraps every attempt (including retries) in the standard onion shape: receive options, call `next`, return a `Response`.

```typescript
import { defaultHeaders, requestLogger } from "relay/middleware";

// Add default headers to every request (per-request headers win on conflict)
client.use(defaultHeaders({
  Authorization: "Bearer token123",
  "X-Client-Version": "1.0.0",
}));

// Log request timing
client.use(requestLogger());

// Custom middleware
client.use(async (options, next) => {
  console.log("Request:", options.url);
  const response = await next(options);
  console.log("Response:", response.status);
  return response;
});
```

Middleware runs inside the timeout and cancellation wiring, so a hung middleware gets cancelled along with the request.

## Schema validation

Pass a `parse` function to validate and type the response body. Relay ships a Zod adapter:

```typescript
import { z } from "zod";
import { withZod } from "relay/zod";

const UserSchema = z.object({
  id: z.number(),
  name: z.string(),
  email: z.string().email(),
});

const ticket = client.get<User>("/users/1", { parse: withZod(UserSchema) });

const result = await ticket.toPromise();
if (result.success) {
  result.data.name; // typed: string
}
```

`parse` is just `(data: unknown) => T`, so any validator that throws on failure works. A failed parse resolves the ticket with a `ValidationError` (carrying the issues) and is never retried.

The core package has no dependency on Zod; only the `relay/zod` entry point imports it. Zod is an optional peer dependency — install it yourself (`npm install zod`) if you use `withZod`.

## Lifecycle events

The client emits typed events across all requests — useful for metrics, logging, and alerting:

```typescript
client.on("request", ({ ticketId, url, method }) => {});  // request submitted
client.on("retry",   ({ ticketId, url, attempt, delayMs }) => {});
client.on("success", ({ ticketId, url, attempt }) => {});
client.on("failure", ({ ticketId, url, error }) => {});   // terminal failure

// Remove a listener
client.off("success", listener);
```

## Cancellation

Cancel from the ticket, or wire in your own `AbortSignal`:

```typescript
const ticket = client.get("/slow-api/data");
ticket.cancel(); // aborts the in-flight attempt and settles the ticket

const controller = new AbortController();
const ticket2 = client.get("/api/data", { signal: controller.signal });
controller.abort(); // same effect: ticket resolves with CancelledError
```

Cancellation wins over everything else: if you abort while a timeout is also firing, the result is `CancelledError`. A cancelled request is never retried.

## Error handling

Errors are a closed hierarchy under `RelayError`, so an `instanceof` chain covers every failure mode:

| Error | Meaning | Notable fields |
| --- | --- | --- |
| `NetworkError` | Network failure or non-2xx response | `statusCode`, `response`, `cause` |
| `TimeoutError` | Attempt exceeded `timeoutMs` | `url`, `timeoutMs` |
| `ValidationError` | Response body failed `parse` (never retried) | `issues` |
| `CancelledError` | Ticket cancelled or signal aborted | — |
| `MaxRetriesExceededError` | All attempts exhausted | `attempts`, `lastError` |

```typescript
import { MaxRetriesExceededError, NetworkError } from "relay";

const result = await ticket.toPromise();
if (!result.success) {
  const { error } = result;
  if (error instanceof MaxRetriesExceededError) {
    // error.lastError is the underlying AppError from the final attempt
  } else if (error instanceof NetworkError) {
    // error.statusCode, error.response
  }
}
```

## Configuration reference

### `ClientConfig`

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `baseUrl` | `string` | — | Prepended to relative request URLs |
| `concurrency` | `number` | `10` | Global cap on in-flight retries across partitions |
| `trigger` | `TriggerConfig` | — | Default `timeoutMs` and `queueOnStatus` |
| `retry` | `RetryConfig` | 3 retries, exponential backoff | Default retry policy |
| `partitions` | `Record<string, PartitionConfig>` | — | Per-partition overrides (concurrency, queue size, trigger, retry) |
| `logger` | `Logger` | — | Structured logger with `debug`/`info`/`warn`/`error` |

### `RequestOptions`

| Option | Type | Description |
| --- | --- | --- |
| `method` | `string` | HTTP method (set by `get`/`post`/etc.) |
| `headers` | `Record<string, string>` | Request headers |
| `body` | `BodyInit` | Request body |
| `partition` | `string` | Partition name (defaults to hostname) |
| `parse` | `(data: unknown) => T` | Validate and type the response body |
| `trigger` | `TriggerConfig` | Per-request trigger overrides |
| `retry` | `RetryConfig` | Per-request retry overrides |
| `signal` | `AbortSignal` | External cancellation |

## API reference

### `HttpClient`

```typescript
static create(config?: ClientConfig): HttpClient

// HTTP methods — all return immediately with a Ticket
get<T>(url: string, options?: RequestOptions<T>): Ticket<T>
post<T>(url: string, body?: BodyInit, options?: RequestOptions<T>): Ticket<T>
put<T>(url: string, body?: BodyInit, options?: RequestOptions<T>): Ticket<T>
patch<T>(url: string, body?: BodyInit, options?: RequestOptions<T>): Ticket<T>
delete<T>(url: string, options?: RequestOptions<T>): Ticket<T>
request<T>(url: string, options?: RequestOptions<T>): Ticket<T>

// Middleware
use(middleware: MiddlewareFn): this

// Lifecycle events
on<K extends keyof LifecycleEventMap>(event: K, listener: (data: LifecycleEventMap[K]) => void): this
off<K extends keyof LifecycleEventMap>(event: K, listener: (data: LifecycleEventMap[K]) => void): this
```

### `Ticket<T>`

```typescript
// Properties
readonly id: string
readonly status: TicketStatus
readonly signal: AbortSignal
readonly isCancelled: boolean

// Methods
toPromise(): Promise<Result<T>>
cancel(): void

// Events
on(event: "done", listener: (result: Result<T>) => void): this
on(event: "error", listener: (error: AppError) => void): this
on(event: "update", listener: (update: TicketUpdate) => void): this

// Async iterator over state changes
subscribe(): AsyncGenerator<TicketUpdate>
```

## Design notes

**Why tickets instead of promises?** A promise is a single future value. A resilient request has a lifecycle — queued, retrying, done — and you may want to observe or cancel it mid-flight. A ticket gives you that surface while still offering a plain `toPromise()` for code that just wants the answer.

**Why does the first attempt skip the bulkhead?** Fresh requests should not wait behind retry traffic for a host that happens to be degraded. The bulkhead exists to throttle *retry* pressure onto struggling hosts, which is where thundering herds come from.

**What Relay does not do.** No response caching, no request deduplication, no streaming response helpers, no browser support. It is deliberately narrow: queueing, retries, isolation, and typed results on top of `fetch`.

## Development

```bash
npm install       # install dependencies
npm run build     # compile TypeScript to dist/
npm test          # run the test suite (vitest)
npm run test:watch
npm run typecheck # tsc --noEmit
```

## Contributing

New to Relay? Start with [ONBOARDING.md](ONBOARDING.md), a guided tour of the codebase that follows one request through the library. When you're ready to contribute, read [CONTRIBUTING.md](CONTRIBUTING.md) for setup, commands, and the behavioral invariants your change must preserve.

## License

MIT
