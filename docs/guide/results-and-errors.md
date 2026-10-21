# Results and errors

What a finished request gives you: a typed, validated body, or one of a fixed set of typed errors.

## Typed results

Pass a `parse` function to validate and type the response body. It's just `(data: unknown) => T | Promise<T>`, so any validator that throws or rejects on failure works.

```typescript title="A typed body"
const ticket = client.get<User>("/users/1", {
  parse: (data) => data as User, // or your own throwing validator
});

const result = await ticket.toPromise();
if (result.success) {
  result.data.name; // typed: string
}
```

`json<T>()` is the built-in, dependency-free version of that cast.

### When `parse` fails

A failed parse resolves the ticket with a `ValidationError`, and it's never retried.

With `parse` set, a body that isn't valid JSON fails the same way. That includes an empty body, such as a `204` or any `HEAD` response. The server did answer, and asking again would get the same answer.

`parse` runs inside the attempt, so waiting for an async `parse` counts against `attemptMs` and `totalMs`. A parse that never settles ends as a timeout, and `cancel()` ends it too.

### Response types

`responseType` sets how the body is read before `parse` sees it. It defaults to `"json"` when `parse` is set.

Without `parse`, `data` is the body read that way:

| `responseType` | `data` without `parse` |
| --- | --- |
| `"json"` | `unknown` (decoded, not validated) |
| `"text"` | `string` |
| `"arrayBuffer"` | `ArrayBuffer` |
| `"blob"` | `Blob`, typed with the response's `content-type` |
| `"none"` | `undefined`; the body is cancelled unread |

```typescript title="Text and no body"
const csv = await client.get("/export.csv", { responseType: "text" }).toPromise();
if (csv.success) csv.data; // string

await client.delete("/users/1", { responseType: "none" }).toPromise(); // 204: nothing to read
```

The body is read inside the attempt, so `attemptMs` and `totalMs` bound the read.

With neither `parse` nor `responseType`, the body is left unread on `result.raw`, and `data` is `undefined`.

### Zod adapter (optional)

Vereda ships a Zod adapter, `withZod`. It validates with `parseAsync`, so async refinements and transforms work.

Zod is an optional peer dependency. Only the `@vereda/http/zod` entry point imports it, and the core keeps zero dependencies.

```typescript title="Validating with a schema"
import { z } from "zod";
import { withZod } from "@vereda/http/zod";

const UserSchema = z.object({
  id: z.number(),
  name: z.string(),
  email: z.email(),
});

const ticket = client.get("/users/1", { parse: withZod(UserSchema) });

const result = await ticket.toPromise();
if (result.success) {
  result.data.name; // typed: string
}
```

## Error handling

A failure is always one of Vereda's error classes, never an arbitrary thrown value. They all extend `RequestError`, and `AppError` is the union of them.

Every class has a readonly, literal-typed `kind`. Switching on it narrows to that class and its fields. `instanceof` works too.

```typescript title="Switching on kind"
const result = await ticket.toPromise();
if (!result.success) {
  switch (result.error.kind) {
    case "max_retries":
      result.error.lastError; // MaxRetriesExceededError: the final attempt's error
      break;
    case "http":
      result.error.statusCode; // HttpError: also .response
      break;
    case "circuit_open":
      result.error.partition; // CircuitOpenError: the partition that is failing fast
      break;
    default:
      console.error(result.error.message);
  }
}
```

Keep a `default` branch like this one. A minor release may add an error class with a new `kind` (see [Versioning and support](../../README.md#versioning-and-support)). A `switch` that ends in a `const unreachable: never = result.error` check would stop compiling when that happens. The `default` branch handles it at run time instead.

### The error classes

| Error | `kind` | When | Fields |
| --- | --- | --- | --- |
| `NetworkError` | `"network"` | No response arrived: DNS failure, connection reset and so on | `cause` |
| `HttpError` | `"http"` | A non-2xx status outside `retry.retryOnStatus`, e.g. `404` | `statusCode`, `response` |
| `RetryableStatusError` | `"retryable_status"` | A non-2xx status in `retry.retryOnStatus`, e.g. `503` | `statusCode`, `response`, `retryAfterMs?` |
| `TimeoutError` | `"timeout"` | An attempt ran past `timeout.attemptMs` | `url`, `timeoutMs` |
| `DeadlineExceededError` | `"deadline"` | The ticket ran past `timeout.totalMs` | `url`, `totalMs`, `cause` |
| `ValidationError` | `"validation"` | The body failed `parse` or isn't valid JSON | `issues`, `cause` |
| `CancelledError` | `"cancelled"` | The ticket was cancelled or its signal aborted | — |
| `QueueFullError` | `"queue_full"` | A partition's queue or the global queue was full | `scope`, `partition`, `queueSize`, `maxQueueSize` |
| `CircuitOpenError` | `"circuit_open"` | The partition's breaker was open when an attempt was due | `partition` |
| `RateLimitedError` | `"rate_limited"` | The [rate limit](resilience.md#rate-limiting) would have made an attempt wait past `maxWaitMs` | `partition`, `waitMs`, `maxWaitMs` |
| `ConfigurationError` | `"configuration"` | The request itself is invalid (see below) | `key` |
| `MaxRetriesExceededError` | `"max_retries"` | Retries ran out while the failure was still transient | `attempts`, `lastError` |

### Which errors are retried

Only `network`, `timeout` and `retryable_status` are retried by default. See [What gets retried](resilience.md#what-gets-retried) in the Resilience guide.

Every other error is terminal: it resolves the ticket on the first attempt that produces it.

### Details by error

- **`RetryableStatusError`.** Its `response` has the status and headers only. The body was cancelled.
- **`DeadlineExceededError`.** It's also raised when the next retry's delay wouldn't fit before the deadline. Then `cause` is the last attempt's error.
- **`QueueFullError`.** `scope` is `"partition"` or `"global"`. A partition queue holds retries, plus first attempts when `limitFirstAttempts` is on. For the global queue, `partition` is `"global"`, but a partition can have that name too, so check `scope`.
- **`CircuitOpenError` and `RateLimitedError`.** The attempt that was due wasn't sent. Earlier attempts of the same ticket may have run.
- **`ConfigurationError`.** A relative URL with no `baseUrl`, a bare `ReadableStream` body, a body factory that threw, or invalid request-level `timeout` or `retry` options. Invalid client config throws from `create()` instead.

### Errors from a later body read

`TimeoutError` and `DeadlineExceededError` don't only arrive as `result.error`. They can also reject a body read you do later, on `result.raw` or `HttpError.response`, as in the README's first example. See [Reading the body later](../operations.md#reading-the-body-later) in the Operations guide.
