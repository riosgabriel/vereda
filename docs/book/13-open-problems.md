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

### #203: huge timeouts fire almost at once

*Bug. Chapters 1, 5, 6 and 11.*

This is the trap chapter 1 described, still open in four places. Node can't hold a timer longer
than 2^31−1 ms, about 24.8 days. Ask for more and it waits 1 ms instead, with only a warning.
`Infinity` is safe, because the code skips the timer for it. A large *finite* number isn't.

Our running example shows it. Give it `attemptMs: 3e9` (about 35 days) instead of 200, and the
first try, which hangs, times out after 3 ms instead of 200. The request still succeeds, because
the server answers on the third try, but every attempt now has about a millisecond to work. Give
it `totalMs: 3e9` instead, and the whole request fails with a `DeadlineExceededError` after about
13 ms, having asked the server once.

The issue lists four options that accept such values: `attemptMs`, `totalMs`, the backoff's
`maxDelayMs`, and the rate limit's `maxWaitMs`.

**Where to start.** Chapter 11 showed how `close()` got the same fix: a validator in
`src/core/validate.ts` and a named limit, `MAX_TIMER_MS`. Read `validateCloseOptions` there, then
find where each of the four options is validated, and where its timer is set (the issue's table
points to each file).

**The design question.** A number the caller *wrote* can be rejected with a `ConfigurationError`,
as `close()` now does. A number the code *computed* (a backoff with jitter, a `Retry-After`
header, a token-bucket wait) can't be rejected, because nobody wrote it; it has to be clamped to
the limit instead. Decide which of the four is which. The issue also asks whether
`maxDelayMs: Infinity` should be legal, meaning "no cap", as `attemptMs: Infinity` is.

**Acceptance.** A test per option, written first and failing on `main`. Use a fake server that
answers after 50 ms and check that the request succeeds rather than timing out.

### #192: one registry for every kind of partition state

*Internal refactor, milestone 1.3. Chapters 8 and 9.*

Three classes keep per-partition state, and they're nearly copies: the bulkhead registry, the
breaker registry and the retry-budget registry. Each keeps a map from partition name to its entry
and when it was last used. Each sweeps old entries every tenth lookup, or once it has more than
100. And each asks the entry whether it may be removed, but under three spellings: `isIdle` in
one, `isEvictable(now)` in the other two. The rule behind that question is where an old bug came
from (chapter 11, Rule 2: never remove state that's still in use).

The issue proposes one generic registry, built from a function that makes an entry for a
partition name, and used by all three. Each caller keeps merging its own config.

**Where to start.** Put the three `get` methods side by side, in `src/queue/bulkhead.ts`,
`src/queue/circuit-breaker.ts` and `src/queue/retry-budget.ts`, and list every difference. Two to
look for. First, the bulkhead and breaker registries can list every entry without updating when
each was last used, so watching a partition never keeps it alive; the generic version must keep
that. Second, since #194 a partition can turn the client's retry budget or rate limit off with
`false`, and the two registries spell that check differently. Config merging stays with the
callers, but make sure the shared code doesn't get in its way.

**Acceptance (from the issue).** All three registries use it with no change in behavior, the
existing prune tests stay green without edits, and `test/queue/prune-held-reference.test.ts`
covers the generic registry once instead of once per kind.

### #191: pause a partition when a 429 says when to come back

*Design and enhancement, milestone 1.3. Chapters 7 and 8.*

When a server answers `429 Too Many Requests` with a `Retry-After` header, it's telling every
caller to wait. Today the client listens only for the one request that got the 429: its retry
waits (chapter 7). Every other request to the same host keeps going, and probably gets its own
429. The issue proposes an opt-in partition setting that holds every attempt to that partition
until the time the server gave.

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

Our running example makes three tries. The `retry` events number them by *retry*: the first
`retry` event carries attempt 0, though it follows the first try. `retryWhen` numbers them by
*attempt*: it's asked about attempt 0 after the first try fails. Same request, two counting
schemes, and code that reads both gets one of them wrong. The proposal is one 1-based `attempt`
everywhere (1 is the first try), plus a separate retry index where that's useful, and a migration
guide.

Because it breaks code that reads those numbers, it waits for 2.0, and the issue collects other
breaking changes until then. Some have already landed as 1.x deprecations, so 2.0 can remove the
old forms (#189): a bulkhead snapshot's `name` in favour of `partition`, the `"global"` partition
name on a full global queue in favour of `scope`, and a `circuitBreaker` config that does nothing
without `enabled: true`. The CHANGELOG's "Deprecated" section lists them.

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

The last one is worth a sentence, because our running example shows it. The client logs
"Request initiated", "Request queued for retry", "Request succeeded" for a success on the *first*
try, and "Request failed after retries". Our request, which succeeds on its third try, logs only
the first two. A cancel logs nothing. Decide whether the logger should mirror the three terminal
events, and if so, where each line belongs.

And a few doc fixes, smaller still:

- [ONBOARDING.md](../../ONBOARDING.md) says the prerequisite is Node 18+; `package.json` asks for
  22 or later.
- AGENTS.md and CONTRIBUTING.md say `npm run typecheck` runs three checks; it runs four (the
  fourth covers `performance/`).
- CONTRIBUTING.md names `### Removed` as the heading that makes a release a major one; the release
  script also treats `### Breaking` that way.
- `CHANGELOG.md`'s unreleased section has two `### Changed` headings.
- In `src/core/validate.ts`, the doc comment for `validateRequestOptions` sits above the constant
  before it, so editors show it on the wrong name.

## Choosing one

If this is your first change, take a doc fix or the import-guard test: small, real, and a full
trip through the test-and-review loop from chapter 12.

If you've read the whole book, take #203. It's a real bug with a known shape, the `close()` fix
in chapter 11 shows the pattern, and the design question (reject or clamp?) is small enough to
settle in the pull request.

If you want a design problem, take #191, and write the open questions down as a table of options
before any code.
