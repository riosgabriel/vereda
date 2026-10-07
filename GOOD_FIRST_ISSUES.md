# Good first issues

A small, curated list of verified starter tasks for new contributors. Every item below has been confirmed against the current code and test suite — pick one, optionally pair with the `guide-me` skill, and open a PR.

> This list is intentionally small and **verified**. Do not add an item unless you have confirmed the gap exists in the code or tests. If you want something else, open an issue or ask in the issue tracker.

## 1. Reject fetch-forbidden methods instead of burning all retries client-side

Tracked in [#139](https://github.com/riosgabriel/vereda/issues/139).

`TRACE` and `CONNECT` are forbidden methods per the Fetch spec — Node's `fetch` throws a `TypeError` before ever opening a connection. `TRACE` is also in Vereda's idempotent-methods set (`src/queue/policy.ts`), so a `TRACE` request currently retries `maxRetries` times against a client-side error that can never succeed, wrapping in `NetworkError` each time — zero server hits, but a full backoff cycle wasted. This is called out in `test/core/retry-matrix.test.ts` (see the comments around the `TRACE` row) as known-but-unaddressed behavior.

**Fix:** in request validation (`src/core/validate.ts`) or at the entry to `executeRequest`, reject `TRACE`/`CONNECT` up front with a `ConfigurationError` instead of letting them enter the retry loop. Update the retry-matrix test's `TRACE` row to expect the new terminal error and zero retries.
