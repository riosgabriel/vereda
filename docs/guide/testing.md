# Testing

Making a dependency fail on purpose, so you can see how your service copes. Back to the [README](../../README.md).

## Fault-injecting fetch

`faultyFetch` wraps a `fetch` and makes some calls fail. It lives in its own entry point, so it costs nothing unless you import it:

```typescript
import { faultyFetch } from "@vereda/http/testing";
```

Pass the result as the client's [custom `fetch`](requests.md#custom-fetch). It's a plain function: no globals, no dependencies, and nothing to undo afterwards.

**Example**

```typescript
import { HttpClient } from "@vereda/http";
import { faultyFetch } from "@vereda/http/testing";

const client = HttpClient.create({
  timeout: { attemptMs: 5_000 },
  fetch: faultyFetch(fetch, {
    rate: 0.1,
    faults: [{ status: 503, retryAfter: 1 }, { latencyMs: 2_000 }, { networkError: true }],
    seed: 42,
  }),
});
```

One call in ten gets one of the three faults, picked evenly. The rest go to the real `fetch`.

## The faults

Each fault is a plain object with exactly one of these keys:

| Fault | What the call does |
| --- | --- |
| `{ status, retryAfter?, body?, headers? }` | Answers with that status, without calling the inner `fetch`. A `retryAfter` number is sent as seconds. |
| `{ latencyMs }` | Waits, then calls the inner `fetch` as usual. |
| `{ networkError: true }` | Rejects with a `TypeError`, as `fetch` does when the network fails. |
| `{ hang: true }` | Never settles, until the request's signal aborts. |

`status` runs from 200 to 599, because a `Response` can't carry a 1xx code.

Both waits listen to the request's signal. When it aborts, the call rejects with the signal's reason and its timer is cleared. A signal that is already aborted rejects at once. That makes `hang` a good way to test `timeout.attemptMs`.

Options are checked when you call `faultyFetch`. A bad one throws a `ConfigurationError` there, not on the first request.

## Same faults every run

With a `seed`, the faults come out in the same order every run. Without one, they come from `Math.random`.

Each call takes two numbers from the generator: the first decides whether it gets a fault (`rate`), the second picks which one. Both are always taken. Changing `rate` therefore keeps the pick sequence as it was, and only moves which calls are hit.

Use `match` to limit the faults to some calls:

```typescript
import { faultyFetch } from "@vereda/http/testing";

const flaky = faultyFetch(fetch, {
  faults: [{ status: 500 }],
  match: (request) => new URL(request.url).hostname === "payments.example.com",
});
```

Calls that `match` rejects go straight through and take no numbers from the generator. `match` sees the method, headers and URL. It doesn't read the body.

## Fake timers

`latencyMs` uses the global `setTimeout` when the call is made, so fake timers work. Advance the clock, and the inner `fetch` runs after the delay.

## Example: testing a circuit breaker

A breaker that never opens is a bug you only find during an outage. Make every call fail and check that it does.

```typescript
import assert from "node:assert/strict";
import { CircuitOpenError, HttpClient } from "@vereda/http";
import { faultyFetch } from "@vereda/http/testing";

const client = HttpClient.create({
  timeout: { attemptMs: 1_000 },
  retry: { maxRetries: 0 },
  circuitBreaker: { enabled: true, failureThreshold: 3, resetTimeoutMs: 60_000 },
  fetch: faultyFetch(fetch, { faults: [{ status: 503 }, { networkError: true }], seed: 1 }),
});

for (let i = 0; i < 3; i++) await client.get("https://api.example.com/items").toPromise();

const result = await client.get("https://api.example.com/items").toPromise();
assert(!result.success && result.error instanceof CircuitOpenError);
assert.equal(client.circuits()[0]?.state, "open");

await client.close();
```

The first three calls fail, the breaker opens, and the fourth is refused without a request. The inner `fetch` here is the real one, but it is never called, because `rate` defaults to 1 and every fault answers on its own. Pass a stub if you also want `latencyMs` calls to have somewhere to go.
