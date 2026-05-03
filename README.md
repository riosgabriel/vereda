# Relay

A resilient HTTP client for Node.js with automatic queuing, retries, and bulkhead isolation.

## Features

- **Ticket-based API** - Non-blocking requests that return a `Ticket` object
- **Automatic Retries** - Exponential backoff with optional jitter
- **Bulkhead Pattern** - Isolate failures by partition with concurrency limits
- **Request Queuing** - Automatic queuing for rate-limited (429) or unavailable (503) responses
- **Timeout Protection** - Cancel slow requests and queue them for retry
- **Middleware Support** - Intercept and modify requests/responses
- **Type Safety** - Full TypeScript support with schema validation
- **Lifecycle Events** - Monitor request lifecycle with typed events
- **Cancellation** - Cancel in-flight requests via AbortSignal

## Installation

```bash
npm install relay
```

## Quick Start

```typescript
import { HttpClient } from "relay";

const client = HttpClient.create();

// Make a request - returns immediately with a Ticket
const ticket = client.get("https://api.example.com/users/1");

// Consume the result as a promise
const result = await ticket.toPromise();
if (result.success) {
  console.log(result.data); // Typed response data
} else {
  console.error(result.error); // Typed error
}
```

## Core Concepts

### Ticket

A `Ticket` represents an in-flight or queued request. It provides:

- **Status tracking** - `pending`, `queued`, `retrying`, `done`, or `cancelled`
- **Promise interface** - `toPromise()` for async/await usage
- **Async iterator** - `subscribe()` for streaming updates
- **Cancellation** - `cancel()` to abort the request
- **Events** - `on("done")`, `on("error")`, `on("update")`

```typescript
const ticket = client.get("/api/data");

// Check status
console.log(ticket.status); // { state: "pending" | "queued" | "retrying" | "done" | "cancelled" }

// Wait for result
const result = await ticket.toPromise();

// Or subscribe to updates
for await (const update of ticket.subscribe()) {
  console.log(update); // { type: "queued" } | { type: "retrying", attempt, delayMs } | ...
}
```

### Configuration

```typescript
const client = HttpClient.create({
  // Base URL prepended to all requests
  baseUrl: "https://api.example.com",

  // Global concurrency limit (default: 10)
  concurrency: 5,

  // Global trigger settings
  trigger: {
    timeoutMs: 5000, // Cancel requests taking longer than 5s
    queueOnStatus: [429, 503], // Queue on these status codes
  },

  // Global retry settings
  retry: {
    maxAttempts: 3,
    backoff: {
      baseDelayMs: 200,
      maxDelayMs: 30000,
      jitter: true,
    },
  },

  // Per-partition overrides (keyed by hostname by default)
  partitions: {
    "api.example.com": {
      concurrency: 3,
      maxQueueSize: 50,
    },
  },

  // Custom logger
  logger: {
    debug: (msg, meta) => console.debug(msg, meta),
    info: (msg, meta) => console.info(msg, meta),
    warn: (msg, meta) => console.warn(msg, meta),
    error: (msg, meta) => console.error(msg, meta),
  },
});
```

### Retry Configuration

```typescript
// Simple backoff options
retry: {
  maxAttempts: 5,
  backoff: {
    baseDelayMs: 1000,
    maxDelayMs: 30000,
    jitter: true, // Add randomness to prevent thundering herd
  },
}

// Or provide a custom backoff function
retry: {
  maxAttempts: 3,
  backoff: (attempt) => Math.min(100 * 2 ** attempt, 10000),
}
```

### Bulkhead Isolation

Relay uses the bulkhead pattern to isolate failures by partition (hostname by default):

```typescript
const client = HttpClient.create({
  // Global concurrency
  concurrency: 10,

  // Partition-specific configs
  partitions: {
    "api.external.com": {
      concurrency: 2, // Only 2 concurrent requests to external API
      maxQueueSize: 10, // Max 10 pending requests in queue
    },
    "api.internal.com": {
      concurrency: 20, // Higher concurrency for internal API
    },
  },
});

// Partition is automatically determined by hostname
// Or specify manually:
client.get("/path", { partition: "my-partition" });
```

### Middleware

Add middleware to intercept and modify requests/responses:

```typescript
import { defaultHeaders, requestLogger } from "relay/middleware";

// Add default headers to every request
client.use(defaultHeaders({
  "Authorization": "Bearer token123",
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

### Schema Validation

Use the Zod adapter for type-safe response parsing:

```typescript
import { z } from "zod";
import { withZod } from "relay/zod";

const UserSchema = z.object({
  id: z.number(),
  name: z.string(),
  email: z.string().email(),
});

const ticket = client.get("/users/1", {
  parse: withZod(UserSchema),
});

const result = await ticket.toPromise();
if (result.success) {
  // result.data is typed as { id: number; name: string; email: string }
  console.log(result.data.name);
}
```

### Lifecycle Events

Monitor the request lifecycle with typed events:

```typescript
client.on("request", ({ ticketId, url, method }) => {
  console.log(`Request ${ticketId}: ${method} ${url}`);
});

client.on("success", ({ ticketId, url, attempt }) => {
  console.log(`Success ${ticketId} after ${attempt} attempts`);
});

client.on("failure", ({ ticketId, url, error }) => {
  console.log(`Failed ${ticketId}: ${error.message}`);
});

client.on("retry", ({ ticketId, url, attempt, delayMs }) => {
  console.log(`Retry ${ticketId}: attempt ${attempt}, waiting ${delayMs}ms`);
});
```

### Cancellation

Cancel requests using the built-in cancellation or an external AbortSignal:

```typescript
const ticket = client.get("/slow-api/data");

// Cancel directly
ticket.cancel();

// Or use an external signal
const controller = new AbortController();
const ticket = client.get("/api/data", {
  signal: controller.signal,
});

// Later...
controller.abort();
```

## API Reference

### HttpClient

```typescript
static create(config?: ClientConfig): HttpClient

// HTTP methods
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

### Ticket

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

// Async iterator
subscribe(): AsyncGenerator<TicketUpdate>
```

### Result Type

```typescript
type Result<T> =
  | { success: true; data: T; raw: Response }
  | { success: false; error: AppError };
```

### Error Types

- `RelayError` - Base error class
- `NetworkError` - HTTP errors, network failures
- `ValidationError` - Schema validation failures
- `TimeoutError` - Request timeout
- `CancelledError` - Request cancelled
- `MaxRetriesExceededError` - All retry attempts exhausted

## Advanced Usage

### Streaming Updates with Async Iterator

```typescript
const ticket = client.get("/api/slow-endpoint");

for await (const update of ticket.subscribe()) {
  switch (update.type) {
    case "queued":
      console.log("Request queued");
      break;
    case "retrying":
      console.log(`Retrying (attempt ${update.attempt}), waiting ${update.delayMs}ms`);
      break;
    case "done":
      console.log("Request complete", update.result);
      break;
    case "cancelled":
      console.log("Request cancelled");
      break;
  }
}
```

### Per-Request Configuration

```typescript
const ticket = client.get("/api/data", {
  // Override global retry config
  retry: {
    maxAttempts: 5,
    backoff: { baseDelayMs: 500, jitter: true },
  },

  // Override trigger config
  trigger: {
    timeoutMs: 10000,
    queueOnStatus: [429, 500, 502, 503, 504],
  },

  // Custom headers for this request
  headers: { "X-Custom": "value" },

  // Request body (for POST/PUT/PATCH)
  body: JSON.stringify({ key: "value" }),

  // Partition override
  partition: "high-priority",

  // External abort signal
  signal: abortController.signal,
});
```

## Building and Testing

```bash
# Install dependencies
npm install

# Build
npm run build

# Run tests
npm test

# Run tests in watch mode
npm run test:watch

# Type check
npm run typecheck
```

## License

MIT
