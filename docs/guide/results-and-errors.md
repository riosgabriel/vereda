# Results and errors

What a finished request gives you: typed, validated bodies and a closed set of error classes. Back to the [README](../../README.md).

## Typed results

Pass a `parse` function to validate and type the response body. `parse` is just `(data: unknown) => T`, and any validator that throws on failure works. A failed parse resolves the ticket with a `ValidationError` and is never retried. With `parse` set, so does a body that isn't valid JSON, including an empty one (a `204`, or any `HEAD` response): the server answered, and asking again would get the same answer.

```typescript
const ticket = client.get<User>("/users/1", {
  parse: (data) => data as User, // or your own throwing validator
});

const result = await ticket.toPromise();
if (result.success) {
  result.data.name; // typed: string
}
```

`json<T>()` is the built-in, dependency-free version of that cast.

### Zod adapter (optional)

Zod is an optional peer dependency. Only the `@vereda/http/zod` entry point imports it; the core has zero dependencies. Vereda ships a Zod adapter for it:

```typescript
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

Errors are a closed hierarchy under `RequestError`, and `AppError` is the union of all of them. Every class carries a readonly, literal-typed `kind`, so switching on it narrows to that class and its fields (`instanceof` works too):

| Error | `kind` | Meaning | Notable fields |
| --- | --- | --- | --- |
| `NetworkError` | `"network"` | Request failed before a response arrived (DNS, connection reset, etc.) | `cause` |
| `HttpError` | `"http"` | Non-2xx response outside `retry.retryOnStatus` (e.g. `404`) | `statusCode`, `response` |
| `RetryableStatusError` | `"retryable_status"` | Non-2xx response matching `retry.retryOnStatus` (e.g. `503`) | `statusCode`, `response` (status and headers only; its body was cancelled), `retryAfterMs?` |
| `TimeoutError` | `"timeout"` | Attempt exceeded `timeout.attemptMs` | `url`, `timeoutMs` |
| `DeadlineExceededError` | `"deadline"` | Ticket exceeded `timeout.totalMs`, or its next retry delay wouldn't fit before it (terminal — not retried) | `url`, `totalMs`, `cause` (last attempt's error, when a retry was skipped) |
| `ValidationError` | `"validation"` | Response body failed `parse` or isn't valid JSON (terminal — never retried) | `issues`, `cause` |
| `CancelledError` | `"cancelled"` | Ticket cancelled or signal aborted (terminal) | — |
| `QueueFullError` | `"queue_full"` | A partition's retry queue, or the global queue (`partition: "global"`), was full (terminal) | `partition`, `queueSize`, `maxQueueSize` |
| `CircuitOpenError` | `"circuit_open"` | The partition's breaker was open when an attempt was due, so it wasn't sent; earlier attempts may have run (terminal) | `partition` |
| `ConfigurationError` | `"configuration"` | A relative URL with no `baseUrl`, a bare `ReadableStream` body, a body factory that threw, or invalid request-level `timeout`/`retry` options (terminal). Invalid client config throws from `create()` instead | `key` |
| `MaxRetriesExceededError` | `"max_retries"` | Retries ran out while the failure was still transient (terminal) | `attempts`, `lastError` |

Only `network`, `timeout`, and `retryable_status` are retried by default — see [What gets retried](resilience.md#what-gets-retried) above. Everything else is terminal: it resolves the ticket on the first attempt that produces it.

`TimeoutError` and `DeadlineExceededError` can also arrive outside a `Result`: as the rejection of a body read performed later, on `result.raw` or `HttpError.response` (see the hero example above) — not only as `result.error`.

```typescript
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

Because the set is closed, a `switch` with a `const unreachable: never = result.error` default fails to compile if a case is missing.
