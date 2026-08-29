# Good first issues

A small, curated list of verified starter tasks for new contributors. Every item below has been confirmed against the current code and test suite — pick one, optionally pair with the `guide-me` skill, and open a PR.

> This list is intentionally small and **verified**. Do not add an item unless you have confirmed the gap exists in the code or tests. If you want something else, open an issue or ask in the issue tracker.

## 1. Add unit tests for the built-in middleware helpers — tests

- **Where:** `src/middleware/index.ts` exports `defaultHeaders` and `requestLogger`.
- **Reality:** only a *custom* middleware is exercised today (`test/core/client.integration.test.ts:227`). The two built-in helpers have no dedicated test.
- **Task:** add a test file (e.g. `test/middleware/middleware.test.ts`) covering `defaultHeaders` (base headers merged, request headers win on conflict) and `requestLogger` (logs on success and on failure, honors a custom `log`).
- **Why it's good:** small, isolated, and you learn the `MiddlewareFn` shape used across the retry path.
