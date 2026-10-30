# 7. Deciding to retry

> **Crux:** Which failures are retried, how long does Vereda wait, and which error does the caller finally see?

Chapter 5 showed *where* the retry decisions happen: once after the first attempt, and at the
top of each round of the retry loop. This chapter is about *what* they decide. Every time a try
fails, the client answers three questions:

1. **Should this failure be retried?** Answered in `src/queue/policy.ts`.
2. **How long should it wait first?** Answered in `src/core/backoff.ts`, unless the server said.
3. **When retrying stops, what does the caller get?** Answered at the end of the retry loop in
   `src/queue/retry.ts`.

Get one of these wrong and you either hammer a host with requests that can't succeed, charge a
customer twice, or hand the caller an error that hides what really happened.

Our running example asks these questions twice. `GET /users/42` timed out on its first try, and
its second try got a 503. Both times the answers were "yes, retry", "wait a random while", and
in the end the caller got the user. This chapter explains those answers, then changes the
example a little at a time to see the others.

## Our request's two decisions

Here are the moments from chapter 5's timeline where a decision was made, with the question
behind each one.

```text
  210  attempt 1 timed out          Retry a timeout on a GET?        yes
  212  event retry 0, wait 4 ms     How long?                        random, 0–200 ms
  217  fetch #2 → 503               Retry a 503 on a GET?            yes
  224  event retry 1, wait 281 ms   How long?                        random, 0–400 ms
  513  event success                What does the caller get?        the user
```

Both "yes" answers come from the same two rules, the two waits come from one formula, and the
result is easy because the last try worked. The rest of the chapter takes each question in turn.

## Every failure has a kind

The first question is about the failure, so start with how failures are described. Every
failure is an instance of a class in `src/core/errors.ts`, and every class carries a literal
**kind**: a short string the code (and your code) can switch on. Each kind has a class named
after it; a `timeout` is a `TimeoutError`, a `retryable_status` is a `RetryableStatusError`.

| Kind | Produced by | Retried? |
| --- | --- | --- |
| `network` | `fetch` threw for a reason other than our own abort, or the body stream died mid-read | yes |
| `timeout` | the attempt's `attemptMs` timer | yes |
| `retryable_status` | a status in the retry list (408, 425, 429, 500, 502, 503, 504 by default) | yes |
| `http` | any other non-2xx status | no |
| `validation` | malformed JSON, or your `parse` threw | no |
| `configuration` | bad request options, a bad URL, a body factory that threw | no |
| `deadline` | the total deadline expired, or the next wait would pass it | no, ends the ticket |
| `cancelled` | `cancel()`, your abort signal, `close()` | no, ends the ticket |
| `queue_full` | a partition queue or the global queue was full | no, ends the ticket |
| `circuit_open` | the circuit breaker refused the try | no, ends the ticket |
| `rate_limited` | the wait for a rate-limit token, or for a `Retry-After` pause, would be too long | no, ends the ticket |
| `max_retries` | retries ran out on a failure that kept being transient | only ever final |

"Ends the ticket" means the error stops the request where it happens, without asking the
retry policy. The other errors are put to the policy, and only the first three pass.

Our request met two kinds: `timeout` on the first try and `retryable_status` on the second.
Both are in the top three.

All twelve classes extend one base class, `RequestError`, which stores the kind and an optional
`cause`. A helper, `isAppError`, checks whether a value is one of the twelve. Catch-all code
uses it to keep a typed error as it is and wrap anything else.

> **Aside: the list can grow.** The project's rule (README, "Versioning and support") is that a
> minor release may add a class and a kind, but never change an existing one. `RateLimitedError`
> was added this way (#145). That's why the docs tell you to end a `switch` on the kind with a
> `default` branch rather than a check that every case was handled.

## Should it be retried?

The default retry policy is two rules, and the function is short enough to read whole:

`src/queue/policy.ts` — `defaultRetryPolicy`
```typescript
export const RETRIABLE_KINDS: ReadonlySet<AppError["kind"]> = new Set(["network", "timeout", "retryable_status"]);

export function defaultRetryPolicy(error: AppError, _attempt: number, ctx: RetryPolicyContext): boolean {
	// Rule 2 — the error kind must be transient.
	if (!RETRIABLE_KINDS.has(error.kind)) return false;
	// Rule 3 — the request must be safe to repeat (idempotent by method or opt-in).
	if (isIdempotentMethod(ctx.method)) return true;
	if (ctx.idempotent) return true;
	if (ctx.headers && new Headers(ctx.headers).has("idempotency-key")) return true;
	return false;
}
```

**The failure must be one that might go away.** A dropped connection, a timeout or a "try again
later" status might be gone in a second. A 404, a body that doesn't parse or a bad option will
be exactly the same next time. Our timeout passes this rule, and so does our 503.

**The request must be safe to send twice.** HTTP calls a method *idempotent* when sending it
twice has the same effect as sending it once. GET, HEAD, OPTIONS, PUT and DELETE are; POST and
PATCH are not. Think of a POST that creates a payment and then times out: the server may have
created it before the connection died, and a retry could create a second one. Our request is a
GET, so it passes.

A POST or PATCH is retried only if you say it's safe, in one of three ways: set
`idempotent: true` in the request's retry options, send an `Idempotency-Key` header yourself, or
set `retry.idempotencyKey: true` and let Vereda generate that header. That header is a common
convention: the server remembers the key and ignores a repeat. The check goes through the
standard `Headers` class, so the header's capitalisation doesn't matter. The generated key is one
per request, reused on every attempt.

The comments say "Rule 2" and "Rule 3" because the function's doc comment lists five rules. The
other three live elsewhere: the attempt limit is the retry loop's bound, your own predicate is
the next section, and cancellation and the deadline are the loop's gates (chapter 5).

### Our request, as a POST

Change one thing in the running example: call `api.post` instead of `api.get`. The first try
still hangs and times out at 200 ms. But this time the policy's second rule says no, so there
is no retry at all:

```text
    1  event request
   14  fetch #1              ...hangs
  205  event failure         kind timeout, attempts 1
```

The caller gets the raw timeout error. Nothing was retried, so nothing was "exhausted"; the
policy simply refused. Add an `Idempotency-Key` header, or set `retry.idempotencyKey: true` so
Vereda generates one, and you're back to three fetches and a success.

### Your `retryWhen` can only say no

You can pass your own predicate, `retryWhen`, in the retry options. The client never calls it
directly. Both call sites, the first attempt and the retry loop, go through one function that
puts the default policy first:

`src/queue/policy.ts` — `shouldRetry`
```typescript
export function shouldRetry(
	error: AppError,
	attempt: number,
	ctx: RetryPolicyContext,
	retryWhen?: (error: AppError, attempt: number) => boolean,
): boolean {
	if (!defaultRetryPolicy(error, attempt, ctx)) return false;
	if (retryWhen && !retryWhen(error, attempt)) return false;
	return true;
}
```

Your predicate runs only after the default policy said yes, so it can turn a yes into a no but
never a no into a yes. You can't use it to retry a 404 or an unmarked POST. For those there are
explicit settings: add the status to `retryOnStatus` (which turns it into a `retryable_status`
failure), or mark the request idempotent.

If our running example had a `retryWhen` that logged its arguments, it would print two lines:
`retryWhen(timeout, 0)` right after the first try, and `retryWhen(retryable_status, 1)` right
after the second. Its second argument is the zero-based number of the try that just failed.

That number is easy to confuse with the `retry` event's. The event counts *retries* from zero,
so "retry 0" is the second try. For the same moment, then, your predicate sees `0` meaning "try
0 failed" and the event that follows says `0` meaning "retry 0 is starting".

> **Aside: one numbering, later.** Issue #148 proposes a single 1-based attempt number
> everywhere in 2.0, because this mismatch is easy to get wrong.

## How long to wait?

> **See it run:** the [backoff and jitter simulator](https://vereda.dev/patterns/backoff-jitter/) plays this with and without the pattern.

### Backoff

When nothing else says how long to wait, the **backoff** function does. It takes the round
number of the retry loop and returns milliseconds:

`src/core/backoff.ts` — `buildBackoffFn`
```typescript
return (attempt: number): number => {
	const exponential = baseDelayMs * 2 ** attempt;
	const capped = Math.min(exponential, maxDelayMs);
	if (!jitter) return capped;
	// Full jitter: random value in [0, capped]
	return Math.random() * capped;
};
```

The defaults are a base of 200 ms, a ceiling of 30 seconds and jitter on. So the ceiling doubles
each round, 200, 400, 800 ms and so on, and the actual wait is a random number below it. That's
our request's two waits: round 0 drew 4 ms out of 0–200, and round 1 drew 281 ms out of 0–400.
Run the example again and you'll get different numbers in the same ranges.

This is called **full jitter**: the whole wait is random, not "the exponential value plus a bit
of noise". It exists for the case where a thousand clients fail at the same moment. Without
randomness they all retry at the same moment too, fail together again, and keep doing it in
lock step. Spreading them across the whole range breaks that up. The price is that some retries
go out almost at once, like our 4 ms one.

You can also pass `backoff` as a function from round to milliseconds. `buildBackoffFn` then
returns your function untouched.

### The server's `Retry-After` wins

A server that answers 429 or 503 may add a `Retry-After` header saying when to come back. If it
does, that value replaces the backoff:

`src/queue/retry.ts` — `resolveRetryDelay`
```typescript
function resolveRetryDelay(
	lastError: AppError,
	backoffFn: (attempt: number) => number,
	attempt: number,
	cap: number,
): number {
	if (lastError instanceof RetryableStatusError && lastError.retryAfterMs !== undefined) {
		return Math.min(lastError.retryAfterMs, cap);
	}
	return backoffFn(attempt);
}
```

There's no jitter on this path: the server named a time, and the client honours it. There is a
cap, though, so a server can't park a ticket for an hour. The cap is the backoff's ceiling,
`maxDelayMs`, when you gave backoff options, and the default 30 seconds when you gave a function,
since a function has no ceiling to read.

The header is read in `src/queue/executor.ts` by `parseRetryAfter`. It accepts whole seconds
(`"2"` becomes 2,000 ms) or an HTTP date (the time from now until then, never below zero), in any
of the three forms RFC 9110 says a recipient must accept: `Sun, 06 Nov 1994 08:49:37 GMT`, the
obsolete `Sunday, 06-Nov-94 08:49:37 GMT`, and the obsolete `Sun Nov  6 08:49:37 1994`, which
means UTC though it doesn't say so. The dates are parsed by hand, because `Date.parse` takes
`"1.5"` or `"-5"` as dates and reads the last form as local time. Anything else, such as `"1.5"` or `"-5"`, is ignored, and backoff applies.

If our fake server's 503 carried `Retry-After: 1`, the second wait would be exactly 1,000 ms on
every run, instead of a random draw. That's chapter 5's first exercise.

By default, `Retry-After` changes only the wait of the ticket that received it. Other requests to
the same host carry on with their own schedules.

> **Aside: pausing a whole host.** With the opt-in `pauseOnRetryAfter` option (issue #191), a
> 429 or 503 with `Retry-After` pauses the whole partition, which is closer to what the server
> asked for. `Bulkhead.guard` records it as the attempt settles, `Bulkhead.takeToken` waits it out
> ahead of every attempt, and a queued attempt that reaches the front during the pause is bounced
> back to `takeToken`. The pause lives in `PartitionPause` (`src/queue/pause.ts`), one per
> bulkhead; it only moves forward, and `maxPauseMs` (30 s by default) clamps a long header.
>
> The retry loop knows about it in three places. The deadline check compares the longer of the
> backoff and what is left of the pause, so a pause past `totalMs` fails at once with
> `DeadlineExceededError`. `refusalAfter` fails a retry with `RateLimitedError` (its
> `pausedUntil` is set) when the pause will still be running after the sleep and `maxWaitMs`
> would refuse it. And the `retry` event's `delayMs`, and the ticket's `retrying` update, report
> that longer wait. A first attempt gets the deadline check too, in `_fireFirstAttempt`, after
> the breaker's `tryAcquire`.

## What the caller sees when retrying stops

Retrying can stop in four ways, and they don't all hand the caller the same error:

| How it stopped | The caller gets |
| --- | --- |
| A try succeeded | the data |
| The policy, your `retryWhen` or the retry budget refused another try | the last try's error, as it was |
| The breaker, the deadline, a full queue, the rate limit or a cancel stopped it | that gate's own error |
| Every retry ran and failed | a wrapped "max retries" error, *or* the last error as it was |

Our request ended in the first row. To see the last row, make the fake server answer 503 every
time:

```text
   13  fetch #1  → 503       retry 0, wait 18 ms
   33  fetch #2  → 503       retry 1, wait 394 ms
  429  fetch #3  → 503       retry 2, wait 645 ms
 1077  fetch #4  → 503
 1079  event failure         kind max_retries, attempts 4
```

Three retries are the default, so the client makes four tries in all, then gives up. The caller
gets a `MaxRetriesExceededError`, which carries the attempt count and keeps the last 503 inside
it, as `lastError` and as the standard `cause`.

The "or" in the last row is the subtle part, and it lives right after the loop:

`src/queue/retry.ts` — `runRetryLoop` (after the loop)
```typescript
// All retries exhausted — total attempts = 1 (first) + maxRetries (loop)
totalAttempts = 1 + maxRetries;
onCleanup?.();

// The final attempt's own error was never run through the gate above —
// ... If it wouldn't have been
// retried anyway (e.g. a non-retryable HttpError, or a ValidationError
// from a failed parse), it's terminal on its own merits: surface it raw,
// ... Only genuinely transient exhaustion — the
// final error was itself retryable, retries just ran out — gets wrapped.
// This intentionally checks the default policy only, not retryWhen:
// retryWhen is never consulted for an attempt that has no retries left.
if (!defaultRetryPolicy(lastError, maxRetries, ctx)) {
	onFailure?.(lastError, totalAttempts, totalQueuedMs);
	controller.markDone({ success: false, error: lastError } as never);
	return;
}

const exhaustedError = new MaxRetriesExceededError(totalAttempts, lastError);
```

The wrapper means "this kept failing in a way that might have gone away, and we stopped
trying". Suppose instead the server answered 503, 503, then 404. The 404 is a definite answer:
the user doesn't exist. Wrapping it would make it look like one more transient failure, and the
caller would have to dig inside to find out. So the loop asks the policy about the final error
too. If the policy wouldn't have retried it anyway, the caller gets it as it is: a plain
`http` error after three fetches.

Two smaller cases follow from the same idea:

- A POST that gets a 503 isn't retried, so the caller sees the raw 503 error. Nothing ran out.
- With `maxRetries: 0`, nothing is ever wrapped. The first error goes straight to the caller.

> **Aside: where the unwrapping came from.** Surfacing a definite final answer instead of
> wrapping it is #95. Before it, a 404 that arrived on the last try was reported as "max
> retries exceeded".

## Design note: why `retryWhen` can't force a retry

A more flexible design would let your predicate override the default policy in both
directions. Vereda deliberately doesn't. The comment above `shouldRetry` says so, "`retryWhen`
can only veto a retry, never force one", and the policy's doc comment lists its rules as
conditions that must *all* hold.

The consequence is that two safety rules hold whatever a caller's predicate does: a request that
isn't safe to repeat is never repeated without an explicit opt-in, and a definite answer is
never retried. The opt-ins are named settings (`idempotent`, `retryOnStatus`) that stand out in
a code review, rather than a branch hidden inside a function. The repo doesn't record a
discussion of the alternative.

Why does the policy run *before* your predicate rather than after? The comment on `shouldRetry`
says the ordering "lives in one place" so that both call sites agree. Running yours second also
means it's never called about a failure that wouldn't be retried anyway. That keeps a promise
the docs make: your predicate is called once for each failed try that could still be retried,
never more.

## What must stay true

- Only `network`, `timeout` and `retryable_status` failures are retried, and only for
  idempotent methods or with an explicit opt-in (`idempotent: true` or an `Idempotency-Key`
  header).
- `retryWhen` runs after the default policy, can only say no, and is called once per failed
  try that could still be retried. Never with `maxRetries: 0`, never about the final try.
- A `validation` failure is never retried.
- A server's `Retry-After` replaces backoff, without jitter, capped at `maxDelayMs` (or 30 s
  when backoff is a function).
- A `Retry-After` pause only ever moves forward: a later, shorter header never ends it early.
- The `retry` event's `delayMs` is the wait the retry really has, a pause included.
- The "max retries" wrapper is used only when the final failure was itself transient; a
  definite final answer reaches the caller as it is.
- A new kind of error may be added in a minor release; an existing kind never changes outside a
  major one.

## Try it

1. **Compute, then check.** With `backoff: { baseDelayMs: 100, maxDelayMs: 250, jitter: false }`,
   what are the waits before retries 1 to 4? Check with
   `import { buildBackoffFn } from "./src/core/backoff.ts"` and
   `[0, 1, 2, 3].map(buildBackoffFn({ ... }))`. (`[100, 200, 250, 250]`.)
2. **Predict, then run.** The server answers 503 with `Retry-After: 2`, then 200. Backoff is
   `{ baseDelayMs: 1, maxDelayMs: 500, jitter: false }`. What wait does the `retry` event
   report? (500: the 2,000 ms from the header, capped.) Now make `backoff` a function,
   `(n) => 7 * (n + 1)`, and send `Retry-After: 1`. (1000: the header wins, and the cap is the
   default 30 s.)
3. **Predict, then run.** A GET gets 503, 503, 404, with the default `maxRetries`. How many
   fetches, and what kind does the caller see? (3 fetches, kind `http`, not `max_retries`.)
4. **Predict, then run.** A POST with the header `Idempotency-Key: abc` against a server that
   always answers 503. Remember that `post` takes the body as its second argument and the
   options as its third. (4 fetches, kind `max_retries`, with `attempts` 4.)
5. **Predict, then run.** `retryWhen: (_e, attempt) => attempt < 1` against a server that always
   answers 503. (2 fetches: the predicate allows the first retry, then says no to the second.
   The caller gets the raw `retryable_status` error.)
6. **Read the matrix.** `test/core/retry-matrix.test.ts` builds a table of method × failure ×
   options and checks the number of requests and the final kind for each, with `maxRetries: 2`
   unless a row says otherwise. Before reading the loop that builds `postRows`, predict the
   expected requests and kind for a POST that gets a 429, once with `idempotent: false` and once
   with `idempotent: true`. (1 request and `retryable_status`; 3 requests and
   `max_retries_exceeded`, the test's readable name for kind `max_retries`.)
