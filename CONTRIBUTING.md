# Contributing to Vereda

Thanks for your interest! Vereda is a small, focused library, and we're glad to have help.

**New to the codebase?** You have two on-ramps: read [ONBOARDING.md](./ONBOARDING.md) for a self-guided tour that follows one request through the whole library, or run the **`guide-me`** skill in your harness (Claude Code, OpenCode, etc.) — it's bundled in `.claude/skills/` and `.opencode/skills/` and will walk you through the internals interactively.

## Setup

```bash
git clone https://github.com/riosgabriel/vereda.git
cd vereda
npm install
```

Requires Node 18+.

## Commands

```bash
npm test          # run the full suite (vitest) — 30 tests
npm run typecheck # tsc --noEmit
npm run build     # compile TypeScript to dist/
```

Run a single test file or a single test:

```bash
npx vitest run test/queue/bulkhead.test.ts
npx vitest run -t "name fragment"
```

Tests are self-contained: integration tests spin up `node:http` servers on ephemeral localhost ports. No network, services, or env vars needed. Keep timing-sensitive tests fast — the suite uses tiny backoff delays (e.g. `baseDelayMs: 10`, `jitter: false`).

## Before you open a PR

- Follow the existing patterns in the codebase.
- Preserve the behavioral invariants below — they're load-bearing.
- Every relative import in `src/` and `test/` must use the `.js` extension (NodeNext ESM), even when importing a `.ts` file.
- `npm run typecheck` skips `**/*.test.ts`; run the tests to keep test code type-safe.
- Zod is an optional peer dependency. Only `src/adapters/zod.ts` may import it; `src/core/` must stay zod-free.

## Behavioral invariants (don't break these)

- The first attempt skips the bulkhead; the bulkhead throttles retry traffic only.
- `retryWhen` is consulted after **every** failed attempt, including attempt 0.
- A failed `parse` (`ValidationError`) resolves immediately and is never retried.
- Cancellation wins over timeouts and retries; a cancelled ticket is never retried.
- `ticket.toPromise()` never rejects — failures are a `Result` union with a closed `RequestError` hierarchy.

See [AGENTS.md](./AGENTS.md) for more gotchas.
