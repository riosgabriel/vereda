# 13. Open problems

> **Crux:** What is still unsolved, and which chapters do I need to solve it?

This appendix is a list of capstone exercises: real, open work in this repo. Each one says which
chapters you need, where to start reading, and what "done" looks like. The first group comes from
the issue tracker: the issues that were open when this book was last updated. The second comes
from chapter 11's review and isn't filed yet.

Before you start any of them, check the tracker. Someone may have picked it up since, and
[CONTRIBUTING.md](../../CONTRIBUTING.md) asks you to claim an issue before opening a pull request
for it.

## From the issue tracker

### #192: one registry for every kind of partition state

*Done: `PartitionRegistry` in `src/queue/partition-registry.ts`. Kept here as a worked example of
the questions below.*

*Internal refactor, milestone 1.3. Chapters 8 and 9.*

Three classes kept per-partition state, and they were nearly copies: the bulkhead registry, the
breaker registry and the retry-budget registry. Each kept a map from partition name to its entry and
when it was last used. Each swept old entries every tenth lookup, or once it had more than 100.

And each asked the entry whether it could be removed, but under three spellings: `isIdle` in one,
`isEvictable(now)` in the other two. The rule behind that question is where an old bug came from
(chapter 11, Rule 2: never remove state that's still in use).

The issue proposes one generic registry, built from a function that makes an entry for a
partition name, and used by all three. Each caller keeps merging its own config.

**Where to start.** Put the three registries side by side, in `src/queue/bulkhead.ts`,
`src/queue/circuit-breaker.ts` and `src/queue/retry-budget.ts`, and list every difference. Two to
look for.

First, the bulkhead and breaker registries can list every entry without updating when each was last
used, so watching a partition never keeps it alive; the generic version must keep that.

Second, a partition can turn the client's retry budget, rate limit or `pauseOnRetryAfter` off with
`false` (#194, #256). Those three merge through one function, `mergeOptional` in
`src/queue/bulkhead.ts`, which the bulkhead and retry-budget registries both call.

Config merging stays with the callers, but make sure the shared code doesn't get in its way.

**Acceptance (from the issue).** All three registries use it with no change in behavior, the
existing prune tests keep passing (only their `isIdle` calls are renamed to `isEvictable`), and
`test/queue/prune-held-reference.test.ts` covers the generic registry once instead of once per
kind.

### #191: pause a partition when a 429 says when to come back

*Done: the opt-in `pauseOnRetryAfter` option (chapter 7's aside). Kept here as a worked example of
the questions below; `src/queue/pause.ts` shows how they were settled.*

*Design and enhancement, milestone 1.3. Chapters 7 and 8.*

When a server answers `429 Too Many Requests` with a `Retry-After` header, it's telling every caller
to wait. Today the client listens only for the one request that got the 429: its retry waits
(chapter 7).

Every other request to the same host keeps going, and probably gets its own 429. The issue proposes
an opt-in partition setting that holds every attempt to that partition until the time the server
gave.

**Questions the issue leaves open.** Is it a flag on `rateLimit`, a separate option, or the
default? Is the pause capped by the backoff's cap or its own? Do first attempts that wait count
toward `maxWaitMs`? And how does it interact with the breaker, which counts a 429 as a failure
today?

**Where to start.** Every attempt already goes through one per-partition wait first: the rate
limit's token bucket (chapter 8). A pause is "no tokens until time T". Read how the bucket hands
out tokens ahead of time, and decide whether a pause fits as a balance below zero.

**Acceptance.** Waits end on cancel (chapter 11, Rule 2), tests use fake timers, and the pause
shows up in `partitions()`, for example as `pausedUntil`.

### #148: one way to count attempts

*Design, breaking, milestone 2.0. Chapters 5 and 7.*

Our running example makes three tries. The `retry` events number them by *retry*: the first `retry`
event carries attempt 0, though it follows the first try. `retryWhen` numbers them by *attempt*:
it's asked about attempt 0 after the first try fails.

Same request, two counting schemes, and code that reads both gets one of them wrong. The proposal is
one 1-based `attempt` everywhere (1 is the first try), plus a separate retry index where that's
useful, and a migration guide.

Because it breaks code that reads those numbers, it waits for 2.0, and the issue collects other
breaking changes until then.

Some have already landed as 1.x deprecations, so 2.0 can remove the old forms (#189): a bulkhead
snapshot's `name` in favour of `partition`, the `"global"` partition name on a full global queue in
favour of `scope`, and a `circuitBreaker` config that does nothing without `enabled: true`. The
CHANGELOG's "Deprecated" section lists them.

**Where to start.** List every place an attempt number reaches a user: the `retry` event, the
ticket's `retrying` update, `retryWhen`, the `attempt` middleware sees, the
`http.request.resend_count` attribute on OpenTelemetry spans, and the count on
`MaxRetriesExceededError`. Write down what each one means for our three-try request today. That
table is most of the migration guide.

## From this book's review

These came out of chapter 11's review and aren't filed. Each needs a failing test or a decision
first. This table is for picking one:

| Problem | Chapters | Start in |
| --- | --- | --- |
| The `node:` import guard misses a bare `import "node:events";` | 2, 11 | the "runtime portability" test in `test/core/emitter.test.ts` |
| A partition's `maxQueueSize` can't be 0; the client-wide one can | 3, 8 | `validateConfig` and `validatePartitionConfig` in `src/core/validate.ts` |
| Two precedence orders for cancel and timeout in the executor | 6, 11 | the catch blocks in `src/queue/executor.ts` |
| The logger reports some endings and not others | 10, 11 | the four logger calls in `src/core/client.ts` |

The last one is worth a sentence, because our running example shows it. The client logs "Request
initiated", "Request queued for retry", "Request succeeded" for a success on the *first* try, and
"Request failed after retries".

> **User 42:** It succeeds on its third try, so it logs only the first two.

A cancel logs nothing. Decide
whether the logger should mirror the three terminal events, and if so, where each line belongs.

And a few doc fixes, smaller still:

- [ONBOARDING.md](../../ONBOARDING.md) says the prerequisite is Node 18+; `package.json` asks for
  22 or later.
- `AGENTS.md` and `CONTRIBUTING.md` say `npm run typecheck` runs three checks; it runs four (the
  fourth covers `performance/`).
- `CONTRIBUTING.md` names `### Removed` as the heading that makes a release a major one; the release
  script also treats `### Breaking` that way.
- In `src/core/validate.ts`, the doc comment for `validateRequestOptions` sits above the constant
  before it, so editors show it on the wrong name.

## Choosing one

If this is your first change, take a doc fix or the import-guard test: small, real, and a full
trip through the test-and-review loop from chapter 12.

If you want a design problem, take #191, and write the open questions down as a table of options
before any code.
