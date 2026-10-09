# Working with requests

Controlling a request in flight and customizing how attempts are sent. Back to the [README](../../README.md).

## Cancellation

Cancel from the ticket, or wire in your own `AbortSignal`:

```typescript
const ticket = client.get("/slow-api/data");
ticket.cancel();

const controller = new AbortController();
const ticket2 = client.get("/api/data", { signal: controller.signal });
controller.abort(); // ticket resolves with CancelledError
```

Cancellation wins over everything else. A cancelled request is never retried.

To shut a client down, `client.close()` cancels everything in flight; `client.close({ drain: true, timeoutMs })` waits for in-flight tickets first, then cancels whatever is left. Either way, new requests throw `ConfigurationError("client closed")`. See the [shutdown sequence](../operations.md#shutdown-sequence) in the operations guide.

## Tickets

Every request method returns a **Ticket** synchronously — a handle to a request that may take several attempts. Most code only calls `toPromise()`. When you need to watch a request progress through its retries, or stop it partway, the ticket is also what you subscribe to and cancel.

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

A promise is a single future value. A resilient request has a lifecycle — queued, retrying, done — and a ticket exposes that lifecycle while `toPromise()` stays available for code that just wants the answer.

## Middleware

Middleware wraps every attempt (including retries) in the standard onion shape. Each middleware receives a `RequestContext` — `{ url, method, headers, body, signal, attempt, ticketId, partition }`, where `headers` is a real `Headers` instance — and a `next` function that calls the next middleware (or the actual fetch):

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

Middleware can rewrite `ctx.url` before calling `next(ctx)` — whatever URL survives to the innermost middleware is what actually gets fetched. `defaultHeaders()` only sets a header the request doesn't already have; the comparison is case-insensitive, so a request-level `authorization` header always wins over a default `Authorization` one and you never end up sending both.

Middleware receives the same `AbortSignal` the request uses (`ctx.signal`), so it can participate in timeout and cancellation handling — but only if it observes or forwards that signal to the work it performs. If it doesn't, the attempt still ends on time (cancellation, `attemptMs` and `totalMs` settle the ticket either way), but the abandoned work keeps running until it finishes on its own. When a response is handed back unread, the same signal can still abort later, when the body-read bound expires.

## Custom fetch

By default each attempt calls `globalThis.fetch`. Pass `fetch` to swap it for your own function. That function runs inside the innermost middleware, once per attempt (retries included), and receives the final URL plus a `RequestInit` that carries `method`, `headers`, `body`, `signal`, `redirect` (when configured) and `duplex` (for stream bodies). Use it to route requests through your own undici dispatcher, add a proxy, or stub the network in tests. Spread the whole `init` into your call, as the example below does. A function that rebuilds it from a few fields silently drops whatever it leaves out: without `signal`, the ticket still settles on cancel or timeout, but the request itself keeps running on the wire, and without `redirect`, undici follows the hops your guard is meant to check.

For example, a service that fetches URLs supplied by users can guard against SSRF with an undici `Agent` that checks each resolved address in a custom DNS lookup and turns off connection reuse. Import `Agent` and `fetch` from the same `undici` package. Node's built-in `fetch` bundles its own copy of undici, and that copy isn't guaranteed to accept an `Agent` from a different version.

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

`redirect` takes `"follow"` (the default) or `"manual"`, and is set on every attempt's `RequestInit` (middleware sees it as `ctx.redirect`). fetch's `"error"` mode isn't supported: it makes fetch throw on a 3xx, which looks the same as a network failure, so the redirect would be retried and counted against the circuit breaker. Use `"manual"` to reject redirects instead.

With `"manual"`, a 3xx comes back as `success: false` with an `HttpError` (`kind: "http"`). It isn't retried and doesn't count against the circuit breaker, unless you add 3xx codes to `retry.retryOnStatus`, which turns them into retries and discards the response. It does fire a `failure` event, so filter redirects out of failure-rate alerts.

To follow a hop yourself, repeat what `"follow"` would have done for you:

1. Read `error.response.headers.get("location")` and resolve it against the current URL. Then cancel the 3xx body (`await error.response.body?.cancel()`) so its connection is released now, not when the body-read bound expires.
2. If the next URL has a different origin, drop credentials from the headers: `Authorization`, `Cookie` and `Proxy-Authorization`. Otherwise a redirect to another host receives them.
3. On a 303, or a 301/302 answering a `POST`, send the next hop as a `GET` without a body. A 307/308 keeps the method and body.
4. Send it as a new request, which runs `checkUrl` again, and stop after your own hop limit (undici's default is 20).

If your caller already retries at a higher level (a job queue, for instance), set `retry: { maxRetries: 0 }` so you don't stack two retry loops.
