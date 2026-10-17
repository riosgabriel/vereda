# 1. Why Vereda exists

> **Crux:** What does Vereda do that a `fetch` call doesn't, and what did it decide not to do?

You need user 42 from another service. With plain `fetch`, that's one line, and on a good day
it works. This book is about the bad day, which is also its running example: the first try
hangs, the second gets `503 Service Unavailable`, and the third works.

On that day, plain `fetch` waits on the hung request for as long as the operating system lets
it, which can be minutes. If it ever gets past that, the 503 is just another response, and
nothing tries again. To get user 42 you need a loop around `fetch`, and that loop has to make
a surprising number of decisions. Vereda is that loop, written once, with its bugs found and
pinned down by tests.

This chapter looks at the problem from the caller's side and lists the design goals the rest
of the book keeps coming back to. There's no mechanism yet; that starts in chapter 4.

## The loop everyone writes

The project README opens with the code Vereda replaces. Here is its shape, trimmed:

`README.md` — "Why Vereda?"
```typescript
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
```

Run our bad day through it. The hang ends after five seconds, the 503 is thrown and caught,
and the third try returns Ada. So it works, but read the comments as a list of questions. Each
one is a decision Vereda had to make, and each has a home in the code:

| Question in the loop | Where Vereda answers it | Chapter |
| --- | --- | --- |
| Which failures are worth another try? | the retry policy, `src/queue/policy.ts` | 7 |
| Is this request safe to repeat? | the same policy: the method, an `idempotent` flag, an `Idempotency-Key` header | 7 |
| How long to wait between tries? | `src/core/backoff.ts`, plus the server's `Retry-After` | 7 |
| How do I stop a request that hangs? | a timer per attempt, `src/queue/executor.ts` | 6 |
| How does the caller tell a 404 from a timeout? | one error class per kind of failure, `src/core/errors.ts` | 3, 7 |
| How many retries may pile onto a struggling host? | a queue per host, `src/queue/bulkhead.ts` | 8 |
| How do I cancel? | the ticket, `src/ticket/ticket.ts` | 4 |

The loop also has problems it doesn't ask about. Nothing limits the total time across all the
tries. Nothing outside it can cancel it. And if a thousand callers run it against a host that
is down, the host gets four thousand requests. Vereda answers those too: a total deadline,
cancellation, and three opt-in ways to shed load (a circuit breaker, a retry budget and a rate
limiter).

## What a caller sees

From the outside, Vereda is a client object with one method per HTTP verb. Here is our request
for user 42:

`README.md` — "Quick start" (shortened)
```typescript
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
    // ...
    default:
      console.error(result.error.message);
  }
}
```

`get()` doesn't return a promise. It returns a **ticket**: a handle on the request that you can
cancel, watch, or turn into a promise. Chapter 4 is about tickets. Two other things in this
snippet are choices you'll see enforced all through the code.

First, **the promise never rejects.** Every outcome, including a cancel or a mistake found after
the call, comes back as a **result**: either `success: true` with the data, or `success: false`
with an error. The error is always one of Vereda's own classes, and each has a `kind` you can
switch on. That's why the code is full of "settle the ticket with this error" and has almost no
`throw`.

Second, **the per-attempt timeout is required.** It's the only setting you can't leave out. Skip
it and creating the client throws.

## Design goals

The README lists five principles under "Design philosophy". Here they are, each with the place
in the code that keeps it, because these are the things you must not break.

**Fresh traffic comes first.** The first try of a request doesn't wait in the per-host queue
(the **partition bulkhead**, chapter 8). Only retries do. Retries are where a crowd of callers
hammering a sick host comes from, so retries are what get throttled. For our request, the first
try goes straight out; the two retries each pass through the host's queue. The function that
makes this choice is `_fireFirstAttempt` in `src/core/client.ts`, which chapter 5 walks through.

**Backpressure beats unbounded queues.** Every queue in Vereda has a maximum size. When it's
full, the request fails at once with a "queue full" error instead of waiting. Chapter 8 shows the
two queues.

**Cancellation is final.** A cancelled request is never retried. If a cancel and a timeout race,
the caller is told it was cancelled. In the code this is a rule about order: check "was the
ticket cancelled?" before "did the timer fire?". It is repeated in the attempt code and the
retry loop, and chapter 6 shows why.

**Validation failures aren't transient.** If the response arrived but your `parse` function
rejected it, asking again would get the same body. A validation error ends the request at once
and is never retried.

**No silent infinite waits.** This is why the per-attempt timeout is required. The comment on
its type says it best:

`src/core/types.ts` — `ClientTimeoutConfig`
```typescript
/** `ClientConfig.timeout` variant where `attemptMs` is mandatory. Every
 *  client must explicitly decide its per-attempt timeout — `Infinity` is a
 *  legal, deliberate choice to opt out of a cap. This is the one default in
 *  the library that cannot safely be implicit: every other default (retries,
 *  concurrency, queue sizes) fails safe when omitted; an omitted timeout
 *  fails unbounded. ... */
export interface ClientTimeoutConfig extends Omit<TimeoutConfig, "attemptMs"> {
	attemptMs: number;
}
```

Notice that `Infinity` is legal. "No timeout" is allowed, but only as a choice you write down.

There's a trap behind that choice. Node can't hold a timer longer than 2^31 − 1 milliseconds
(about 24.8 days); hand it a bigger delay, `Infinity` included, and it fires after 1 ms. So the
code never passes `Infinity` to a timer. It checks every timeout with a small helper,
`isBoundedMs` in `src/core/types.ts`, and skips the timer when the value isn't a finite
number. Keep this trap in mind; it caused a real bug, and chapter 11 tells that story.

## Design note: why the timeout became mandatory

Early versions had an optional timeout that defaulted to "none". The commit that made it
required (#60, "per-partition circuit breaker + required per-attempt timeout") gives the
reason: every other default in the library fails safe when you leave it out, but a missing
timeout "previously meant 'unbounded' — the same footgun as axios's `timeout: 0`". It landed
before 1.0 because there were "no published consumers yet", so it could break things without a
major version.

The same commit turned every tunable default into a named, exported constant, so the code and
the docs refer to one value. That's why the main entry point exports thirteen `DEFAULT_*`
constants, and why a test, `test/docs/defaults-table.test.ts`, checks the README's table of
defaults against them.

## The defaults at a glance

These are the values you get when you configure nothing else. Use this table for lookup; each
constant can be found with `grep`.

| Setting | Default | Constant and file |
| --- | --- | --- |
| Retries after the first attempt | 3 | `DEFAULT_MAX_RETRIES`, `src/core/types.ts` |
| Backoff base / cap / jitter | 200 ms / 30,000 ms / on | `DEFAULT_BASE_DELAY_MS`, `DEFAULT_MAX_DELAY_MS`, `DEFAULT_JITTER`, `src/core/backoff.ts` |
| Statuses retried | 408, 425, 429, 500, 502, 503, 504 | `DEFAULT_RETRY_ON_STATUS`, `src/core/types.ts` |
| Per-partition concurrency / queue | 5 / 100 | `DEFAULT_CONCURRENCY`, `DEFAULT_MAX_QUEUE_SIZE`, `src/core/types.ts` |
| Global concurrency / queue | 50 / 100 | `DEFAULT_GLOBAL_CONCURRENCY`, `DEFAULT_GLOBAL_QUEUE_SIZE`, `src/core/types.ts` |
| Circuit breaker | off | `CircuitBreakerConfig.enabled` |
| Retry budget, rate limit | none | opt-in config objects |

With these defaults, our request for user 42 gets up to four tries (one plus three retries), so
its bad day fits with one try to spare.

## Non-goals

The README says what Vereda does *not* do: "No response caching, no request deduplication, no
streaming helpers, no browser support." It targets Node.js 22+ services (`package.json` requires
Node `>=22`).

Two more boundaries shape the code even though the README doesn't list them as non-goals:

- **No runtime dependencies.** `package.json` has no `dependencies` field. Zod and
  OpenTelemetry are optional *peer* dependencies, and each is imported by exactly one file.
  Chapter 2 covers that rule.
- **No Node built-in modules in `src/`.** The library uses its own small event emitter and the
  standard `crypto.getRandomValues`, so it loads on Cloudflare Workers too. "No browser
  support" means browsers aren't tested or targeted, not that the code uses Node-only APIs.

> **Aside: a short history.** The repository is young. The first commit is from 2026-05-03;
> most of the design arrived in August and September 2026, in PRs numbered roughly #33 to
> #110. Version 1.0.0 shipped on 2026-09-25, and the package was renamed to `@vereda/http`
> (#115). Dropping the Node built-ins came later, in #174. After 1.0 came a review that found
> seventeen bugs, labelled `B1` to `B17`; their fixes are why many functions carry long
> comments. A later round found three more (#196, #197, #198), fixed in October 2026. The
> latest release is 1.0.2. The unreleased part of `CHANGELOG.md` adds the retry budget, rate
> limiting, async `parse`, `responseType`, OpenTelemetry, `defaultPartition`, a way for one
> partition to opt out of the client's budget or rate limit, and the first deprecations ahead
> of 2.0 (chapter 3).
>
> When a comment in the code says `(B7)` or `(#181)`, it is pointing at that history. Chapter
> 11 collects those bugs into rules.

## What must stay true

- `toPromise()` never rejects. Every outcome is a result, and every error is one of the classes
  in `src/core/errors.ts`.
- The client-level per-attempt timeout is required. `Infinity` is the only way to say "no cap",
  and it never reaches a timer (`isBoundedMs`).
- Every default is a named constant, and the README's defaults table matches them
  (`test/docs/defaults-table.test.ts`).
- `src/` has no runtime dependencies and no `node:` imports.

## Try it

These exercises use a fake `fetch`, so no network is involved. Create `scratch.mts` at the repo
root and run it with `npx tsx scratch.mts`. Delete it afterwards; it isn't part of any
typecheck.

1. **Predict, then run.** What happens if you create a client with no config at all,
   `HttpClient.create({} as never)`? Wrap it in a `try`/`catch` and print the error's message.
   You should see `Invalid configuration: timeout.attemptMs is required — pass a positive
   number, or Infinity to explicitly opt out of a per-attempt timeout`. Then find the line that
   throws it in `src/core/validate.ts`.

2. **Predict, then run.** A server always answers `503`. How many times is `fetch` called for a
   `GET`, and what `kind` does the result have? And for a `POST`?

   ```typescript
   import { HttpClient } from "./src/core/index.ts";

   let hits = 0;
   const client = HttpClient.create({
     timeout: { attemptMs: 1_000 },
     retry: { backoff: { baseDelayMs: 1, jitter: false } },
     fetch: async () => {
       hits++;
       return new Response("", { status: 503 });
     },
   });
   const get = await client.get("http://x.test/").toPromise();
   console.log(hits, get.success ? "ok" : get.error.kind);
   hits = 0;
   const post = await client.post("http://x.test/", "x").toPromise();
   console.log(hits, post.success ? "ok" : post.error.kind);
   ```

   Answer: `4 max_retries` for the `GET` (one try plus three retries, then a "max retries"
   error wrapping the last 503), and `1 retryable_status` for the `POST` (a `POST` isn't safe
   to repeat, so it isn't retried, and the 503 comes back as it is). Keep the second answer in
   mind: why it *isn't* wrapped in a "max retries" error is a question chapter 7 answers.
