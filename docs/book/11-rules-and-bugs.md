# 11. The rules and the bugs that taught them

> **Crux:** What must stay true whenever you change this code, and how was each rule learned?

Every earlier chapter ended with a short list of what must stay true. This chapter gathers those
lists into seven rules, and tells, for each one, the story of the bug that taught it.

Most of the rules describe something that must *not* happen: nothing leaks, nothing settles twice,
no code of yours changes an outcome. No single function shows a rule like that. You can read the
retry loop line by line and never see that it keeps "exactly one terminal event", because the
rule lives in the agreement between the loop, the first attempt, the ticket and `close()`. That is
why these rules are easy to break, and why they get a chapter.

They were learned the hard way. After 1.0 shipped, a review found seventeen bugs, labelled B1 to
B17. Each one was a place where the obvious code was wrong, and the fix for each became a line in
the review checklist in [AGENTS.md](../../AGENTS.md). Writing this book found three more; they're
fixed now, and the second half of this chapter follows one of them from discovery to merged fix.

For each rule below you get the rule in plain words, what it means for our running example
(`GET /users/42`: hang, 503, then 200), how the code keeps it, and the story in an aside. The
labels and pull-request numbers are collected in a table at the end, so you can look them up
without tripping over them on the way.

## Rule 1: one request, one ending

Every request ends with exactly one terminal event (`success`, `failure` or `cancelled`), and that
event agrees with the ticket's result.

Our request, run as in chapter 5, emits `request`, a `retry` for the timeout, a `retry` for the
503, and then one `success`. If you cancel it 300 ms in, while it waits to try again, you get
`request`, one `retry`, and one `cancelled`, and the ticket resolves with a `CancelledError`.
Two endings, or an ending that disagrees with the result, never.

This matters because everything you learn about your traffic is built from these events: metrics,
traces, logs. A request that reports both `success` and `failure` counts twice. One that emits
`cancelled` while its result says the deadline passed puts it in the wrong bucket on every
dashboard.

The code keeps the rule in three ways, all from earlier chapters. The ticket ignores a transition
it can't make, so marking a cancelled ticket "done" does nothing (chapter 4). Every catch-all path
checks whether the ticket has already settled before it emits anything (chapter 5). And when an
attempt ends because the ticket's own signal fired, the code asks one question to tell a deadline
from a cancel, so both paths give the same answer (chapter 4).

The test that guards this rule is different from the others. `test/core/lifecycle-invariants.property.test.ts`
doesn't check one scenario; it generates a hundred random ones (servers that fail in different
ways, timeouts, cancels at random moments, throwing listeners, `close()` in the middle) and checks,
for every ticket, that it settled, that exactly one terminal event fired, that the event matched,
and that nothing was left holding a slot.

> **Aside — how it was learned.** In the 1.0 review (B7), the first attempt emitted `cancelled`
> when the deadline fired, while the retry loop emitted `failure` for the same situation. Both
> resolved the ticket with `DeadlineExceededError`, so the result was right and one of the events
> was wrong. Earlier still (#69), the first attempt's last-resort catch emitted nothing at all for
> an unexpected error. In both cases the result was fine and only the events were wrong, which is
> the kind of bug a test that checks results can't see. The property test checks the events of
> every ticket it creates.

## Rule 2: every exit gives back what it took

Every slot, timer, listener and response body a request takes is released on *every* way out:
success, failure, cancel, timeout, deadline. Not just on success.

Our request takes several things on its way. During its two waits it holds a timer. Its retries
each take a place in the partition's bulkhead (chapter 8). If you'd enabled the circuit breaker
and it was half-open, the request would hold one of its few trial slots (chapter 9). If you cancel
it in the middle of a wait, all of that must come back, or the next request finds a slot that
nobody will ever free.

The happy path always gets this right, because it's the path everyone tests. The bugs lived on
the others. Here is what the code takes and what gives it back:

| What's taken | What gives it back |
| --- | --- |
| A breaker trial slot | the permit, settled once, released in a `finally` |
| A partition slot, when the global limit then says no | the bulkhead's reject path |
| A place in a queue, for a waiter that is cancelled | an abort listener on the waiter |
| A rate-limit token, for a waiter that is cancelled | `takeToken`'s abort handler hands it back (while a pause freezes the bucket, at most down to 0) |
| A partition's registry entry, while requests use it | `retain()`, released by the ticket's cleanup |
| A response body nobody will read | `body.cancel()` |
| A listener on your `signal` | the ticket's cleanup |
| A timer | `unref()`, so it can't keep the process alive |

All of these follow one pattern, and it's the one to copy: take the resource, then
`try { … } finally { release() }`, with a release that is safe to call twice. A release that only
works once forces you to prove that exactly one path calls it. One that is safe to call twice
lets every path call it. The semaphore's `releaseOnce`, the `released` flag inside every
`retain()`, and the `settled` flag on the breaker's permit are the same idea in three places.

> **Aside — how it was learned.** B1: a half-open trial that ended in a 404, a cancel, a veto or a
> full queue kept its trial slot, and the breaker stayed half-open forever (#87). B9: cancelled
> waiters stayed in the queue and filled it (#88). B12: the registry evicted bulkheads and open
> breakers while requests still used them (#121). B13: unread bodies held their sockets until the
> garbage collector ran (#151). Every one of these is a path other than success.

## Rule 3: an attempt ends when its signal says so

When an attempt is cancelled or times out, it ends at once, even if the code it's waiting on
ignores the abort.

Our first try is the test of this rule. The fake server hangs, and it only gives up because it
listens to the abort signal. A real transport might not listen: a custom `fetch` that drops the
signal, or a middleware that swaps it for another. The rule says the attempt must end at 200 ms
anyway.

The executor keeps the rule by never waiting on something it doesn't control without also waiting
on the signal. Middleware and `fetch`, `parse`, and the body read are each raced against the
attempt's signal (chapter 6). If the slow thing finishes later, its result is thrown away and its
body cancelled.

A related point: to decide whether an attempt timed out, the executor asks whether its *timer's*
signal fired, not what the error is called. Middleware is allowed to wrap errors, and a wrapped
abort error no longer looks like one.

> **Aside — how it was learned.** Before #181, a custom `fetch` that dropped the signal meant
> `cancel()` resolved the ticket but no `cancelled` event fired, and `attemptMs` and `totalMs`
> never resolved the ticket at all. Before #122 (B14), a middleware that wrapped the abort error
> turned a timeout into a network error.

## Rule 4: your code can watch an outcome, never change it

Code you hand to the client to *observe* (event listeners, the metrics sink, the logger) can
throw, and the request carries on as if it hadn't. Its result, its events and its retries stay
the same.

Give our request a logger that throws when it's told "Request queued for retry", the line the
client logs after the first try times out. The request still succeeds with Ada's record, and the
events are still `request`, two `retry`s and one `success`. The logger's error isn't lost: the
client rethrows it on its own, a moment later, where your process's `uncaughtException` handler
sees it, the same way a throwing event listener is reported (chapter 10).

Every call into observer code goes through one of three wrappers: the client's own `emit` for
events and metrics, its `log` for the logger, and the emitter that runs ticket listeners. Each
catches and hands the error to `reportCallbackError`. When you add a new place that calls user
code, route it through one of these.

`parse` and middleware are different. They're not observers; failing an attempt is part of their
job. They may fail it, but only through the attempt's normal classification, never by throwing
out of the client.

> **Aside — how it was learned.** B2 and B3: a throwing ticket listener stopped the ticket from
> resolving, and a throwing client listener turned a success into a failure. The logger was left
> out of that fix, because it was called directly rather than through `emit`. Writing this book
> found the gap (#197); the next section tells that story.

## Rule 5: nothing secret leaves the client

Every URL that reaches an event, a log line or an error message is redacted first. If our request
had been `GET /users/42?token=SECRET`, every event would show the token as redacted.

The client computes the display version of the URL once, when the first attempt starts, and
passes it everywhere. If you add an error class with a `url` field, or a new event, build it from
that display URL, never from the one you were given.

> **Aside — how it was learned.** B5: the veto path, `TimeoutError` and `DeadlineExceededError`
> used the raw URL, so tokens in query strings showed up in failure events and error messages
> (#88).

## Rule 6: read a value where it changes

Report a number (a gauge, a snapshot field) from the code that changes it, not from some code that
happens to run nearby.

The "requests in flight" gauge is the example. If you read it when an event fires, you get a
different number depending on whether the code that emitted the event had already cleaned up.
So the gauge is updated inside the cleanup itself. The time a request spent queued is measured at
each wait for the same reason.

> **Aside — how it was learned.** B15: the in-flight gauge was read at emit time, so its value
> depended on which path emitted (#149). AGENTS.md names B15, with B16, as a bug an existing test
> had encoded.

## Rule 7: prove the bug before you fix it

Write the failing test first, see it fail on `main`, then fix. And when you read an existing test,
check that it asserts what its own comment says.

Our running example uses `baseUrl`, so it would have hit the bug that taught this rule. Before the
fix, every retry fetched the bare path `/users/42` instead of `https://api.example.com/users/42`,
and failed. Our request would have timed out once and then failed twice on an invalid URL, while
a test said all was well.

> **Aside — how it was learned.** B16: with `baseUrl` set, the code that scheduled retries passed
> the caller's relative path to the retry loop (#88). A test even encoded the bug: it expected two
> server hits where its own comment described four. AGENTS.md turned this into its last checklist
> item, "Prove a bug before fixing it".

## The rules a user sees

The seven rules above are about the code's internals. Alongside them, the project keeps promises
users can see. [CONTRIBUTING.md](../../CONTRIBUTING.md) lists them under "Behavioral invariants
(don't break these)", and each has a chapter. This table is for looking them up:

| Promise | Chapter |
| --- | --- |
| The first attempt skips the partition bulkhead | 5, 8 |
| The breaker is checked before the first attempt and before every retry | 5, 9 |
| `retryWhen` is asked once per failed attempt that could still be retried | 5, 7 |
| A `ValidationError` is never retried | 7 |
| Cancellation wins over timeouts and retries | 4, 6 |
| `toPromise()` never rejects | 4 |
| `MaxRetriesExceededError` wraps only transient failures that ran out of tries | 7 |
| `Retry-After` overrides the backoff, up to a cap | 7 |

## Three bugs this book found

Reading the whole codebase closely enough to explain it is a full code review, and it found three
places where the code broke its own rules. Each was reproduced with a script, filed as an issue,
and fixed with a test that failed first. They're all fixed on `main` now, so what's left is the
lesson: how a rule gets broken, and what the fix teaches about keeping it.

### A request cancelled before it started reported a failure (Rule 1)

Suppose you pass our request a `signal` that is *already* aborted. The client cancels the ticket
at once, inside `get()`, so its result is a `CancelledError`. Then the first attempt starts and
begins its early checks: can the URL be resolved, are the options valid, is the breaker open, is
the rate limit reached. Each check that failed emitted `failure` and tried to settle the ticket.
Settling did nothing, since the ticket was already settled. Emitting did something: the client
reported a failure for a request whose result said cancelled.

Rule 1 was broken, and the property test missed it, because it never generated a signal that was
already aborted.

The fix could have added a guard to each early check. It went the other way: one check at the top
of the first attempt.

`src/core/client.ts` — `_fireFirstAttempt`
```typescript
// A ticket that is already settled here was cancelled before it ever
// ran (a pre-aborted `signal`; nothing else can settle it before the
// first await). [...] Doing it here keeps the one-terminal-event
// invariant true for any early exit added later without a per-exit guard.
if (ticket.isSettled) {
  this.emit("cancelled", {
    ticketId: ticket.id,
    url: this.logUrl(url),
    partition: this.tryResolvePartition(url, options),
    attempts: 1,
    // ...
  });
  cleanup();
  return;
}
```

The comment says why one check beats five: an early check added next year can't forget a guard
that it doesn't need. Now our pre-aborted request ends after a few milliseconds with a single
`cancelled` event, no `request` event, and no call to the server.

One field had to change type for this. The `cancelled` event carries the request's partition, and
for a pre-aborted request whose URL can't be resolved, there is no partition. So that field is now
`string | undefined`, like the one on `failure`, and the CHANGELOG lists it under "Changed".

The test is `test/core/pre-aborted-early-exit.test.ts`, one case per early check, and the property
test now also generates already-aborted signals.

### A logger that threw turned a success into a failure (Rule 4)

The logger was called directly, not through the wrapper that protects events and metrics. So a
throw from the logger travelled up through the request's own code, until something caught it.

Give our request, before the fix, a logger that throws on "Request queued for retry". The first
try times out, the client logs that it's queuing a retry, and the throw goes up to the catch-all.
The catch-all sees a ticket that isn't settled yet and fails it with a `NetworkError` whose
message is the logger's. The server is never asked again: one call, then `failure`, for a request
that would have succeeded on its third try.

The issue that was filed described a different path. On a request that succeeds at the first try,
the order was: emit `success`, log "Request succeeded", then mark the ticket done. A logger that
threw at the second step skipped the third, and the catch-all emitted `failure` after `success`:
two endings, and a success reported as a network error. Either way, it's B3 again, through a door
the original fix didn't close.

The fix added a fourth wrapper next to `emit`: a small private `log` method that calls the logger
inside a `try` and hands any error to `reportCallbackError`. The `requestLogger` middleware got the
same treatment for its output function. The tests are in `test/core/callback-isolation.test.ts`,
under "Logger isolation".

> **Aside — a guess that was wrong.** The issue first guessed that the failure might also be
> *retried*, sending a request that had already succeeded a second time. The tests written for the
> fix showed it wasn't: the throw escaped past the retry decision. The issue was corrected. A guess
> in an issue is fine; label it as one, and check it before it becomes a claim.

### `close()` with an endless drain stopped at once (Rule 2)

`close({ drain: true, timeoutMs })` lets in-flight requests finish, up to `timeoutMs`, before the
client shuts down. The check on `timeoutMs` only rejected missing and non-positive values, so
`Infinity` got through. The drain then started a timer for `Infinity` milliseconds. Node can't
hold a delay longer than 2^31−1 ms (about 24.8 days), so it shortens anything larger to 1 ms,
with only a warning. The "wait as long as it takes" drain cancelled every request after 1 ms.

Chapter 1 described exactly this trap, and the timeout code already avoided it with its
`isBoundedMs` helper. `close()` had been written without it.

The fix is a validator next to the others in `src/core/validate.ts`, with the limit as a named
constant, `MAX_TIMER_MS` (now in `src/core/timer.ts`). A drain now needs a finite `timeoutMs` above 0 and at most that limit:

```text
close({ drain: true, timeoutMs: Infinity })       rejects: requires a finite, positive timeoutMs
close({ drain: true, timeoutMs: 3e9 })            rejects: must not exceed 2147483647 ms
close({ drain: true, timeoutMs: 2_147_483_647 })  ok
```

A rejected call leaves the client open, so you can call `close()` again with a valid value. That
detail is itself an older rule (B8). The tests are in `test/core/close-options.test.ts`.

The same 1 ms trap was open elsewhere, and #203 closed it with one question: who wrote the
number? A finite `attemptMs` or `totalMs` above the limit is the caller's, so creating the client
rejects it, as `close()` does. A retry's backoff, a capped `Retry-After` and a rate-limit token
wait are computed, so nobody can be told to fix them. They go through `setLongTimeout` in
`src/core/timer.ts`, which chains timers of at most `MAX_TIMER_MS` until the whole delay has
passed. Shortening them to the limit instead would have been wrong for the token wait: the
attempt would go out before its token was due.

### What the three have in common

All three broke a rule the code already knew about, on a path the tests didn't reach: a signal
aborted before the request started, a logger instead of a listener, `Infinity` instead of a
number. The rule was written down; the path wasn't. When you review a change, the useful question
isn't "does it keep the rules?" but "which paths does it add, and does each one keep the rules?"

## Smaller findings, still open

These came out of the same review and aren't bugs a user would see. Each is small enough for a
first contribution.

- **The `node:` import guard has a hole.** A test in `test/core/emitter.test.ts` checks that no
  file in `src/` imports a Node built-in. It looks for `from "node:`, `import("node:` and
  `require("node:`. A bare side-effect import, `import "node:events";`, matches none of them.
- **Two queue limits validate differently.** The client-wide `maxQueueSize` may be 0 (refuse
  instead of waiting); a partition's must be at least 1. Nothing says whether that's on purpose.
- **Two precedence orders in the executor.** Some catch blocks check the timer before the cancel,
  others the cancel first (chapter 6). The results agree, but the breaker may record a timeout for
  an attempt that was really cancelled.

## Design note: why the rules live in AGENTS.md

The rules could have lived in code comments, in a design document, or in tests. They live in all
three, but the *list* lives in AGENTS.md, a file written for AI agents that edit the code. That
choice fits how the repo was built: most of it was written with an AI assistant, and the checklist
was the tool for reviewing those changes.

The list works just as well for a person. Use it on every change to `src/core/client.ts`,
`src/queue/` or `src/ticket/`. When you find a new kind of bug, add a line. The logger fix did
exactly that: AGENTS.md's "User callbacks can't change outcomes" now names the logger and the
`log()` wrapper next to listeners and the metrics sink.

## Where each rule came from

For looking up: the bug labels and pull requests behind each rule, and the tests that guard it.

| Rule | Bugs | Fixed in | Guarded by |
| --- | --- | --- | --- |
| 1. One ending | B7, #69, #196 | #88, #201 | `test/core/lifecycle-invariants.property.test.ts`, `test/core/pre-aborted-early-exit.test.ts` |
| 2. Give back what you took | B1, B9, B12, B13, B17, #198 | #87, #88, #121, #151, #199 | `test/queue/prune-held-reference.test.ts`, `test/queue/timer-unref.test.ts`, `test/core/close-options.test.ts` |
| 3. End on the signal | #181, B14 | #181, #122 | `test/queue/signal-deaf-fetch.test.ts` |
| 4. Watch, don't change | B2, B3, #197 | #88, #200 | `test/core/callback-isolation.test.ts` |
| 5. No secrets out | B5 | #88 | `test/core/redact.test.ts` |
| 6. Read where it changes | B15 | #149 | the in-flight gauge check in the property test |
| 7. Prove it first | B16 | #88 | (a practice, not a test) |

The code behind each rule, by file and name:

- Rule 1: `src/ticket/ticket.ts` — `Ticket`; `src/core/client.ts` — `_fireFirstAttempt`.
- Rule 2: `src/queue/circuit-breaker.ts` — `CircuitPermit`; `src/queue/bulkhead.ts` — `_releaseSlot`;
  `src/core/validate.ts` — `validateCloseOptions`; `src/core/timer.ts` — `setLongTimeout`.
- Rule 3: `src/queue/executor.ts` — `settleOnAbort`; `src/queue/executor.ts` — `readBytes`.
- Rule 4: `src/core/listeners.ts` — `reportCallbackError`; `src/core/listeners.ts` — `Emitter`.
- Rule 5: `src/core/redact.ts` — `redactUrl`.

## What must stay true

This chapter is the list. In one breath:

- One request, one terminal event, matching its result, on every path.
- Every way out gives back what the request took.
- An attempt ends when its signal fires, whatever the transport does.
- Observer code (listeners, metrics, the logger) can throw without changing anything.
- No unredacted URL leaves the client.
- Values are read where they change.
- And the user-visible promises in the table above.

## Try it

1. **Watch a fix fail.** Make a throwaway copy of the repo (`git worktree add ../verify HEAD`,
   then link or install `node_modules`). In the copy, delete the `if (ticket.isSettled) { … }`
   block at the top of `_fireFirstAttempt`. Predict how many cases in
   `test/core/pre-aborted-early-exit.test.ts` fail, then run
   `npx vitest run test/core/pre-aborted-early-exit.test.ts`. (Six of seven. The surprise is the
   "valid request" case: with the guard gone, a pre-aborted request also emits a `request` event
   it shouldn't.) Then run the property test in the copy and see whether it finds the bug on its
   own. When we tried, it did, and shrank it to two requests, one pre-aborted, against a rate
   limit with no wait allowed. Because the scenarios are random, your run may need a few tries or
   `VEREDA_FC_RUNS=500`. Delete the copy afterwards.
2. **Predict the events.** Add a `logger` to the running example that records every message and
   throws when the message is `"Request queued for retry"`, and add
   `process.on("uncaughtException", e => console.log("reported:", e.message))`. Predict the result,
   the events, the logged messages and what your handler prints, then run it. (Success with Ada's
   record; `request`, two `retry`s, `success`; your handler prints the logger's error. Only two
   messages are logged, "Request initiated" and "Request queued for retry": nothing logs a
   success that comes from a retry. Chapter 13 has that as an open question.)
3. **Close the import-guard hole.** Change the regular expression in the "runtime portability"
   test in `test/core/emitter.test.ts` so it also catches `import "node:events";`. Prove it first:
   add that line to a file in `src/` in a scratch copy and check that the current test passes
   when it shouldn't.
4. **Extend the property test.** The scenario generator in
   `test/core/lifecycle-invariants.property.test.ts` combines a pre-aborted signal with two kinds
   of early exit, a bad URL and bad options. Read the generator, and decide whether it can also
   reach an open breaker. If it can't, add that as a third kind, and check it still passes.
