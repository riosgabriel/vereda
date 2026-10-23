# 12. How the project checks itself

> **Crux:** How do I prove a change is correct, and how does it get shipped?

You now know how the code works. This chapter is about working *on* it: how the tests are
organized, which kind of test fits which kind of change, what CI checks, and how a merged change
becomes an npm release. It ends with the anatomy of one real feature, so you can see the whole
loop in a single pull request.

Setup and the full command list are in [CONTRIBUTING.md](../../CONTRIBUTING.md) and the
"Commands" section of [AGENTS.md](../../AGENTS.md). In short: `bun install`, then `npm test`,
`npm run typecheck` and `bun run check`.

## Our request as a test

Start with the thing you already know. Here is the running example, the request for user 42
that hangs, gets a 503 and then works, written as a test the suite would accept:

`test/core/running-example.test.ts` (not in the repo; write it yourself in exercise 1) <!-- check-refs: ignore -->
```typescript
it("hangs, gets a 503, then succeeds on the third try", async () => {
	vi.useFakeTimers();
	const fetch = fakeServer(); // a vi.fn: hangs until aborted, then 503, then 200
	const api = HttpClient.create({
		baseUrl: "https://api.example.com",
		timeout: { attemptMs: 200 },
		fetch: fetch as typeof globalThis.fetch,
	});
	const retries: string[] = [];
	api.on("retry", (e) => retries.push(e.error.kind));

	const promise = api.get("/users/42", { parse: json<{ id: number }>() }).toPromise();
	await vi.advanceTimersByTimeAsync(2_000);
	const result = await promise;

	expect(result.success && result.data).toEqual({ id: 42, name: "Ada" });
	expect(fetch).toHaveBeenCalledTimes(3);
	expect(retries).toEqual(["timeout", "retryable_status"]);
});
```

Run for real, the example takes about half a second: a 200 ms timeout plus two random waits.
This test takes about 30 ms, and it checks the same story: three tries, and the two reasons for
retrying from chapter 7. Two techniques make that possible, and they're two of the three the
suite uses.

## Three ways to drive the client

Choosing the right technique is most of writing a good test here.

**An injected `fetch`.** The client accepts a `fetch` option, and the running example's fake
server is exactly that: a function that returns `Response` objects. In a test it's usually a
`vi.fn`, so you can count calls. No sockets, fully predictable. Use it for decision logic: what
is retried, which error comes back, which events fire. `test/queue/deadline-aware-retry.test.ts`
is a compact example.

**Fake timers.** `vi.useFakeTimers()` replaces the clock, and `vi.advanceTimersByTimeAsync(ms)`
moves it forward. Vitest fakes `Date.now()` too, so timeouts, backoff waits and rate-limit waits
run in microseconds. That's how the test above skips our request's 200 ms hang. Use it whenever a
test would otherwise wait on real time. `test/queue/retry-after.test.ts` and
`test/queue/rate-limit.test.ts` lean on it heavily.

**A real local server.** Node's `createServer` on `127.0.0.1`, port 0, so the system picks a free
port. This exercises the real `fetch`, real sockets and real response bodies. Use it when the
transport matters: reading bodies, releasing sockets, a real `Retry-After` header.
`createTestServer` in `test/core/retry-matrix.test.ts` is a reusable shape with a swappable
handler.

When real time can't be avoided, keep it tiny. Most tests use a 10 ms base delay with jitter
off, and the 15 s test timeout is a safety net, not a budget.

> **Aside: the unref trap.** The README's version of the running example needs a `setInterval`
> line, because every Vereda timer is unref'd and a script with nothing else to do can exit
> mid-request. Vitest keeps its worker alive, so tests never hit this. A standalone
> reproduction script will.

## The shape of the suite

At the commit this book describes there are 560 tests in 54 files, all under `test/`. The
directories mirror `src/`:

| Directory | What it tests |
| --- | --- |
| `test/core/` | The client end to end: events, retries, deadlines, metrics, close, validation, isolation |
| `test/queue/` | Each mechanism alone (bulkhead, breaker, budget, rate limiter, executor) plus regression tests for specific bugs |
| `test/ticket/` | The ticket's state machine |
| `test/middleware/`, `test/otel/` | The extension points |
| `test/types/` | Type-level tests, which fail at typecheck rather than at run time |
| `test/docs/` | Tests that keep the Markdown docs honest |
| `test/scripts/` | The release script |

Many test files are named after the bug they pin, and their `describe` blocks carry the bug's
label: `test/queue/abortable-queues.test.ts` and `test/core/pre-aborted-early-exit.test.ts` are
two. When you fix a bug, keep the habit. The label is how the next maintainer finds out *why* the test exists.

## The property test

`test/core/lifecycle-invariants.property.test.ts` is the most valuable test in the repo. Instead
of one test per scenario, it uses the fast-check library to *generate* scenarios. Each one is a
handful of requests with a scripted behavior per try (succeed, 404, 503, network error, hang,
malformed body, a body that stalls), plus random timeouts and deadlines, a cancel at a random
moment, throwing listeners and metrics sinks, a random retry budget, and sometimes `close()`
mid-flight.

For every request in every scenario it checks the rules from chapter 11: the ticket settles, it
fires exactly one ending event, that event matches the result, nothing is left running or
queued, and the in-flight gauge ends at 0. Our request is one of the scenarios it can produce:
hang, then busy, then succeed.

It runs 100 scenarios by default, in about 4 seconds. For a deeper run:

```bash
VEREDA_FC_RUNS=1000 npx vitest run lifecycle-invariants
```

When it fails, fast-check prints a seed and a shrunk scenario: the smallest input it found that
still fails. Turn that into an ordinary regression test next to your fix. The property test's
job is to find bugs, not to document them.

The property test is only as good as its generator. It checks the right rule, but it can only
check it for scenarios it knows how to build. When you add a new way for a request to start or
end, teach the generator about it.

> **Aside: the gap #196 found.** For a long time the generator never combined an
> already-aborted signal with an early failure, such as a bad URL. That pair broke the
> one-ending-event rule, and the property test couldn't see it. The book's first edition found
> it by reading the code. The fix added both to the generator: each request may now get a
> pre-aborted signal and an early exit (an unresolvable URL or an invalid option).

## Tests that keep the docs honest

`test/docs/` treats documentation as code. Four tests:

- `test/docs/readme-snippets.test.ts` pulls every TypeScript code block out of the README, the
  operations guide and the four user guides, and typechecks them all against the real library
  with one compiler run. A snippet must be a complete module, imports included. This book isn't
  on that list, so its snippets aren't checked. They're abridged on purpose.
- `test/docs/defaults-table.test.ts` checks the README's defaults table against the default
  constants. Change a default and this test fails until the table matches.
- `test/docs/retry-table.test.ts` checks the "What gets retried" table in the resilience guide
  against the list of retried status codes.
- `test/docs/middleware-example.test.ts` *runs* the middleware example from the requests guide
  and checks its output.

The snippet test runs the TypeScript compiler from the repo's own `node_modules`. In a git
worktree that has no `bun install` of its own, it's the one test that fails, with "Could not
run …/tsc (dependencies installed?)". That's the environment, not your change.

## Coverage

`npm run test:coverage` enforces thresholds set in `vitest.config.ts`: 96% of lines and
statements, 95% of functions and 92% of branches overall, and 95% of branches in `src/queue/`,
"where the B1–B17 bugs lived". The comment above them states the policy: the thresholds sit just
under the current numbers so coverage "can only ratchet up". Raise them when a change lifts
coverage. Don't lower them to land one.

## What CI runs

`.github/workflows/ci.yml` runs on every push to `main` and on every pull request. There's no
branch filter, so stacked pull requests get CI too.

| Job | What it does | Blocks a merge? |
| --- | --- | --- |
| `lint` | Biome, with warnings treated as errors | yes |
| `test` | On Node 22 and 24: typecheck, tests (with coverage on 22), build, the checkout example, package checks | yes |
| `test-bun` | the whole suite under Bun | yes |
| `smoke-workers` | builds the package and loads it in Cloudflare's workerd runtime | yes |
| `typecheck-next` | `src/` under the next TypeScript major | no |
| `bench` | the `performance/` suite | no |
| `ci` | fails if any blocking job failed; this is the required check | — |

Two details matter when CI fails and your machine passes.

**Bun.** `bun run test` quietly runs the tests under Node, because Bun respects the script's
shebang. To really test under Bun, run `bun run --bun test`. CI sets an expected-runtime
variable, and `test/core/retry-matrix.test.ts` throws if the suite is running under the wrong
one, so a CI job can't silently test the wrong thing.

**The checkout example.** `npm run example:checkout` acts out the README's "one failing
dependency" story and exits with an error if the story stops being true. A change in behavior
can fail it even when every test passes.

Locally, a pre-commit hook runs Biome on staged files. Run `npx husky` once after cloning to
install it.

## How a release happens

A release is a merged version bump. These steps come from CONTRIBUTING.md, checked against
`scripts/release-prepare.ts` and `.github/workflows/release.yml`.

1. **Feature pull requests only add changelog entries.** They go under `## [Unreleased]` in
   `CHANGELOG.md`. Nobody touches the version number in a feature PR.
2. **Prepare.** When you decide to ship, run `npm run release:prepare` on an up-to-date `main`.
   It reads the unreleased section and picks the smallest version bump its headings call for:
   only `### Fixed` is a patch; any `### Added`, `### Changed` or `### Deprecated` is a minor;
   `### Removed` or `### Breaking` is a major. It dates the section, bumps the version and updates
   the compare links. Open a pull request with the result.
3. **Merge.** Merging changes the version in `package.json` on `main`, which starts the release
   workflow. If the new version has no git tag yet, the workflow typechecks, tests, builds, runs
   the package checks, and *stages* the version on npm with Trusted Publishing. There's no npm
   token in the repo.
4. **Approve.** A maintainer approves the staged version with two-factor authentication
   (`npm stage approve <id>`). Only then can anyone install it. The workflow then creates the tag
   and the GitHub release.

Don't push version tags by hand; the workflow creates them.

The last published version is 1.1.1. Everything since sits under `[Unreleased]`: at this book's
pin, the `pauseOnRetryAfter` option and a stricter `Retry-After` parse.

## Anatomy of a feature: the retry budget

The retry budget (chapter 9) is a good model for adding a new mechanism, because it touched every
layer. The squash commit `2e739b3` changed 19 files:

| Layer | Files | What changed |
| --- | --- | --- |
| Types and defaults | `src/core/types.ts`, `src/core/index.ts` | the config type, a default, the new event, exports |
| Validation | `src/core/validate.ts` | checks for the new config, at client and partition level |
| The mechanism | `src/queue/retry-budget.ts` (new) | the budget, its time window, its registry |
| Wiring | `src/core/client.ts`, `src/queue/retry.ts` | creating the registry, the hold, counting first tries, the gate in the retry loop |
| Observability | `src/core/metrics.ts`, `src/core/client.ts` | the new counter and its mapping from the event |
| Tests | `test/queue/retry-budget.test.ts` (new), `test/core/validate.test.ts`, the property test | the math alone, the client end to end, validation, random budgets in scenarios |
| Evidence | `performance/scenarios/retry-storm.ts` | measured load on the server with and without a budget |
| Docs | README, two guides, the operations guide, AGENTS.md, ONBOARDING.md, CHANGELOG | user docs, invariants, the changelog entry |

Three habits from that pull request are worth copying.

1. **A design table in the description.** Each open question ("what counts as a request?",
   "where is it checked?", "what error when it runs out?") with the decision and the reason.
   Chapter 9 quotes it. Without it, the *why* would be lost.
2. **A new mechanism copies an existing one.** The budget's registry and its eviction rules
   deliberately mirror the circuit breaker's, so a reader who knows one knows both.
3. **The property test learns the feature.** A random budget joined the scenario generator, so
   every later change is checked against it.

The repo's `.claude/skills/update-docs/` skill is a checklist of which docs to revisit after a
change like this. It's written for an AI agent, but it reads fine as a checklist for a person.

> **Aside: features keep landing on old ones.** A later pull request (#194) let a single
> partition switch off a client-wide budget or rate limit with `false`. It touched the same
> layers on a smaller scale: the types, validation, the two config-merge functions, tests, the
> resilience guide and the changelog.

## Design note: prove the bug first

AGENTS.md's last review rule is "Prove a bug before fixing it. Write the regression test first
and see it fail on `main`." The fix pull requests in the history follow it and say so in their
descriptions. The fix for #196 is a recent example. Its new test file has seven cases, and the
description reports that six of them fail on `main` without the fix. The seventh is a control: it
checks that a bad URL *without* an aborted signal still fails the normal way, so the fix can't
have broken the ordinary path.

The reason for the rule is that a test can encode a bug and pass. Chapter 11 tells how that
happened here (B16). A regression test you've never seen fail might not test anything. So when a
fix pull request here says "N of M fail without the fix", that's not ceremony. It's the evidence
that the test works.

## What must stay true

- Every bug fix comes with a regression test that fails without it.
- Coverage thresholds only go up.
- The suite passes under Node 22, Node 24 and Bun, and the package loads in workerd.
- A feature that adds a new way for a request to start or end also extends the property test's
  generator.
- Changing a default updates the README's table; changing a documented snippet keeps it
  compiling.
- Feature pull requests add to `[Unreleased]` in `CHANGELOG.md` and never change the version.

## Try it

1. **Write our request as a test.** Put the test from the start of this chapter in a scratch
   copy of the repo, with a `fakeServer()` built from the README's running example and wrapped in
   `vi.fn`. Run it, then delete the `vi.useFakeTimers()` line and the timer advance and run it
   again. How much slower is it, and does it still pass every time? (It should pass both ways. The
   fake-timer version takes about 30 ms; with real timers it takes 0.4 to 0.5 s, and the exact
   time changes from run to run because of the random waits.)
2. **Run the core.** `npx vitest run test/queue/retry-budget.test.ts test/core/lifecycle-invariants.property.test.ts`.
   Both files should pass, 19 tests in all. Then run the property test with
   `VEREDA_FC_RUNS=500` and note how long it takes.
3. **Predict the next release.** Read `## [Unreleased]` in `CHANGELOG.md`. Which bump would the
   prepare script choose? Check without changing anything: import `inferBump` and
   `unreleasedSection` from `./scripts/release-prepare.ts` in a scratch script. (`minor`. The
   section has `### Added`, and no `### Breaking` or `### Removed`.)
4. **Break a default on purpose.** In a scratch copy of the repo, change `DEFAULT_MAX_RETRIES` in
   `src/core/types.ts` from 3 to 4 and run the whole suite. Before you run it, guess which tests
   fail. (Four: the defaults-table test, because the README still says 3, and three tests in
   `test/queue/policy.test.ts` that count exactly four requests. Those three depend on the
   default without saying so. Is that a problem, or a useful alarm?)
5. **See a regression test fail.** In a scratch directory, check out the source as it was just
   before the #196 fix (`git archive c5889e1`), copy in `test/core/pre-aborted-early-exit.test.ts`
   from `main`, and run it. Which cases fail, and which one passes? Read the passing one: why must
   it pass both before and after the fix?
