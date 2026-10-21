# Working with requests

Controlling a request in flight and customizing how attempts are sent. Back to the [README](../../README.md).

## Cancellation

Cancel a request from its ticket, or wire in your own `AbortSignal`.

**Example**

```typescript
const ticket = client.get("/slow-api/data");
ticket.cancel();

const controller = new AbortController();
const ticket2 = client.get("/api/data", { signal: controller.signal });
controller.abort(); // ticket resolves with CancelledError
```

Cancellation wins over everything else. A cancelled request is never retried.

### Closing the client

To shut a whole client down, close it:

| Call | What happens |
| --- | --- |
| `client.close()` | Cancels everything in flight |
| `client.close({ drain: true, timeoutMs })` | Waits for in-flight tickets first, then cancels whatever is left |

Either way, new requests throw `ConfigurationError("client closed")`. See the [shutdown sequence](../operations.md#shutdown-sequence) in the operations guide.

## Tickets

Every request method returns a **Ticket** synchronously: a handle to a request that may take several attempts.

Most code only calls `toPromise()`. When you need to watch a request move through its retries, or stop it partway, you subscribe to the ticket or cancel it.

**Example**

```typescript
const ticket = client.get("/api/data");

// Await the terminal result
const result = await ticket.toPromise();

// Or follow every state change
for await (const update of ticket.subscribe()) {
  // { type: "queued" }
  // { type: "retrying", attempt, delayMs }
  // { type: "done", result }
  // { type: "cancelled" }
}

// Or cancel mid-flight
ticket.cancel();
```

The result is a discriminated union:

```typescript
type Result<T> =
  | { success: true; data: T; raw: Response }
  | { success: false; error: AppError };
```

### Why a ticket, not a promise

A promise is a single future value. A resilient request has a lifecycle: queued, retrying, done.

A ticket exposes that lifecycle, and `toPromise()` stays available for code that just wants the answer.

## Middleware

Middleware wraps every attempt, retries included, in the standard onion shape. Each middleware gets two arguments:

- A `RequestContext`: `{ url, method, headers, body, signal, attempt, ticketId, partition }`. `headers` is a real `Headers` instance.
- A `next` function that calls the next middleware, or the actual fetch.

**Example**

```typescript
import { defaultHeaders, requestLogger } from "@vereda/http/middleware";

client.use(defaultHeaders({ Authorization: "Bearer token123" }));
client.use(requestLogger()); // redacts URL query values/credentials by default

client.use(async (ctx, next) => {
  console.log("Request:", ctx.url, "attempt", ctx.attempt);
  const response = await next(ctx);
  console.log("Response:", response.status);
  return response;
});
```

### Rewriting the URL

Middleware can change `ctx.url` before calling `next(ctx)`. Whatever URL reaches the innermost middleware is what gets fetched.

**Example** (send every request to a staging host)

```typescript
client.use(async (ctx, next) => {
  ctx.url = ctx.url.replace("https://api.example.com", "https://staging.example.com");
  return next(ctx);
});
```

### Default headers

`defaultHeaders()` only sets a header the request doesn't already have. The comparison is case-insensitive.

So a request-level `authorization` header always wins over a default `Authorization` one, and you never send both.

### Signals in middleware

Middleware receives the request's own `AbortSignal` as `ctx.signal`. It takes part in timeouts and cancellation only if it observes that signal or forwards it to the work it does.

If it doesn't, the attempt still ends on time: cancellation, `attemptMs` and `totalMs` settle the ticket either way. But the abandoned work keeps running until it finishes on its own.

When a response is handed back unread, the same signal can still abort later, when the body-read bound expires.

## Custom fetch

By default, each attempt calls `globalThis.fetch`. Pass `fetch` to swap in your own function.

Use it to route requests through your own undici dispatcher, add a proxy, or stub the network in tests.

Your function runs inside the innermost middleware, once per attempt, retries included. It receives the final URL and a `RequestInit` that carries:

- `method`, `headers`, `body` and `signal`
- `redirect`, when configured
- `duplex`, for stream bodies

### Spread the whole `init`

Pass `init` through in full, as the example below does. A function that rebuilds it from a few fields silently drops the rest:

- Without `signal`, the ticket still settles on cancel or timeout, but the request keeps running on the wire.
- Without `redirect`, undici follows the hops your guard is meant to check.

### Example: guarding against SSRF

A service that fetches URLs supplied by users can guard against SSRF with an undici `Agent`. The agent checks each resolved address in a custom DNS lookup and turns off connection reuse.

Import `Agent` and `fetch` from the same `undici` package. Node's built-in `fetch` bundles its own copy of undici, and that copy isn't guaranteed to accept an `Agent` from a different version.

> [!WARNING]
> **A dispatcher-level DNS guard does not survive automatic redirects.** A custom `lookup` only runs when a hostname has to be resolved. A URL with an IP-literal host, such as `http://169.254.169.254/` or `http://127.0.0.1:5432/`, never reaches it. With fetch's default `redirect: "follow"`, a public page that answers `302 Location: http://169.254.169.254/...` gets followed inside undici, and none of your URL checks (scheme, port, IP literal) run on that hop. SSRF-sensitive callers must set the client's `redirect: "manual"`, check every URL themselves, and follow hops in their own loop.

```typescript
import { HttpClient } from "@vereda/http";
import { Agent, fetch as undiciFetch, type RequestInit as UndiciRequestInit } from "undici";

const agent = new Agent({
  connect: { lookup: pinnedLookup }, // resolve, reject private addresses, connect only to the checked ones
  keepAliveTimeout: 1,
  pipelining: 0,
});

// undici's Request/Response types don't line up with Node's global ones, hence the cast.
const vettedFetch = ((url: string, init: UndiciRequestInit) => {
  checkUrl(new URL(url)); // scheme, port, credentials, IP-literal hosts
  return undiciFetch(url, { ...init, dispatcher: agent });
}) as unknown as typeof fetch;

const client = HttpClient.create({
  timeout: { attemptMs: 5_000 },
  redirect: "manual",
  fetch: vettedFetch,
});
```

### Redirect modes

`redirect` is set on every attempt's `RequestInit`. Middleware sees it as `ctx.redirect`.

| Mode | Behavior |
| --- | --- |
| `"follow"` (default) | fetch follows redirects itself |
| `"manual"` | A 3xx comes back to you as a failed result |
| `"error"` | Not supported |

fetch's `"error"` mode makes fetch throw on a 3xx, which looks the same as a network failure. The redirect would be retried and counted against the circuit breaker. Use `"manual"` to reject redirects instead.

### What `"manual"` returns

With `"manual"`, a 3xx comes back as `success: false` with an `HttpError` (`kind: "http"`).

- It isn't retried and doesn't count against the circuit breaker.
- Adding 3xx codes to `retry.retryOnStatus` changes that: they become retries, and the response is discarded.
- It does fire a `failure` event, so filter redirects out of failure-rate alerts.

### Following a hop yourself

To follow a hop, repeat what `"follow"` would have done for you:

1. Read `error.response.headers.get("location")` and resolve it against the current URL. Then cancel the 3xx body (`await error.response.body?.cancel()`) so its connection is released now, not when the body-read bound expires.
2. If the next URL has a different origin, drop credentials from the headers: `Authorization`, `Cookie` and `Proxy-Authorization`. Otherwise a redirect to another host receives them.
3. On a 303, or a 301/302 answering a `POST`, send the next hop as a `GET` without a body. A 307/308 keeps the method and body.
4. Send it as a new request, which runs `checkUrl` again, and stop after your own hop limit (undici's default is 20).

If your caller already retries at a higher level, such as a job queue, set `retry: { maxRetries: 0 }` so you don't stack two retry loops.
