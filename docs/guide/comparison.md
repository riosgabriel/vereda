# Compared with other libraries

How Vereda differs from ky, axios, got, ofetch, cockatiel and opossum, and when one of them is the better pick. Back to the [README](../../README.md).

## At a glance

Most HTTP clients retry. Fewer protect the host you're calling, or the rest of your service, once retrying stops helping.

| | Vereda | ky | axios | got | ofetch | cockatiel | opossum |
| --- | :-: | :-: | :-: | :-: | :-: | :-: | :-: |
| Built on `fetch` | ✅ | ✅ | ⚠️ | ❌ | ✅ | — | — |
| Jittered backoff | ✅ | ✅ | ⚠️ | ⚠️ | ❌ | ✅ | ❌ |
| `Retry-After` | ✅ | ✅ | ✅ | ✅ | ❌ | ⚠️ | — |
| Attempt *and* total timeout | ✅ | ✅ | ⚠️ | ⚠️ | ⚠️ | ✅ | ⚠️ |
| Circuit breaker | ✅ | ❌ | ❌ | ❌ | ❌ | ✅ | ✅ |
| Per-host concurrency | ✅ | ❌ | ❌ | ❌ | ❌ | ⚠️ | ⚠️ |
| Retry budget | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | — |
| Rate limit | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Errors as values | ✅ | ❌ | ❌ | ❌ | ❌ | — | — |
| Dependencies | 0 | 0 | 5 | 10 | 3 | 0 | 0 |

✅ built in · ⚠️ partial (see below) · ❌ no · — not applicable

ky, axios, got and ofetch are HTTP clients. cockatiel and opossum are resilience policies you wrap around any async function, `fetch` included.

## Choosing one

Each library below is the better pick for some job. These paragraphs say which, and what the ⚠️ cells mean.

### ky

[ky](https://github.com/sindresorhus/ky) is a small, well-made wrapper over `fetch`, with retries, jittered backoff, `Retry-After` and hooks. It also runs in browsers, which Vereda doesn't.

If retries are all you need, ky is an excellent choice. Pick Vereda when one slow host must not take the others down with it: ky has no per-host limit, circuit breaker or retry budget.

### axios

[axios](https://axios-http.com/) runs in browsers and Node.js, and its interceptors are familiar to many teams. Retries come from the separate [axios-retry](https://github.com/softonic/axios-retry) package.

`fetch` is one adapter among several. axios-retry's exponential delay has no jitter. `timeout` bounds either the whole request or, with `shouldResetTimeout`, each attempt, not both. That's 4 dependencies, plus 1 for axios-retry.

Stay with axios if a codebase already uses it everywhere and its retries are enough.

### got

[got](https://github.com/sindresorhus/got) is a full-featured Node.js client, with streams, pagination and hooks. It isn't built on `fetch`.

Its backoff adds a fixed ±100 ms of noise instead of jitter, and it has one overall `timeout.request`. Pick got for Node-only code that streams large bodies or walks paginated APIs.

### ofetch

[ofetch](https://github.com/unjs/ofetch) parses JSON for you and runs in Node.js, browsers and workers.

It has a per-attempt timeout, but no deadline across retries. `retryDelay` defaults to 0, and any backoff is a function you write. Pick ofetch when you want a friendlier `fetch` that also runs in the browser.

### cockatiel

[cockatiel](https://github.com/connor4312/cockatiel) brings .NET Polly's policies to JavaScript: retry, circuit breaker, timeout, bulkhead and fallback, composed around any async function.

`Retry-After` needs a custom backoff, and per-host limits need one `bulkhead` per host. Pick cockatiel when the calls you protect aren't HTTP, or when you want to compose the policies yourself.

### opossum

[opossum](https://github.com/nodeshift/opossum) is a circuit breaker for any async function, with fallbacks and a rich set of events.

It has a per-call timeout and no retries. Its `capacity` limit applies per breaker, so per host means one breaker per host. Pick opossum when a circuit breaker is the one pattern you need.

## What Vereda does not do

No response caching, no request deduplication, no streaming helpers, no browser support.

It targets services that depend on other services, on Node.js 22+, Bun or Cloudflare Workers (no `nodejs_compat` needed). For a handful of calls in a script, plain `fetch` is fine.

## How this page is checked

Checked against ky 2.2.0, axios 1.20.0 with axios-retry 4.5.0, got 16.1.0, ofetch 1.5.1, cockatiel 4.0.0 and opossum 10.0.0 in October 2026, from each project's docs and source.

If a row is out of date, please [open an issue](https://github.com/riosgabriel/vereda/issues).
