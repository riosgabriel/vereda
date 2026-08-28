# Contributing to Relay

Thanks for your interest! Relay is a small, focused library, and we're glad to have help.

**New to the codebase?** You have two on-ramps: read [ONBOARDING.md](./ONBOARDING.md) for a self-guided tour that follows one request through the whole library, or run the **`guide-me`** skill in your harness (Claude Code, OpenCode, etc.) — it's bundled in `.claude/skills/` and `.opencode/skills/` and will walk you through the internals interactively.

## Setup

```bash
git clone https://github.com/riosgabriel/relay.git
cd relay
npm install
```

Requires Node 18+.

## Commands

```bash
npm test          # run the full suite (vitest) — 40 tests
npm run typecheck # tsc --noEmit
npm run build     # compile TypeScript to dist/
npm run format    # format all files with Prettier
npm run lint      # run ESLint
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

## Code Style

This project uses Prettier for formatting and ESLint for linting.

**Format on save:** If your editor supports format-on-save (VS Code, etc.), it will work automatically with the `.prettierrc` and `.editorconfig` files.

**Commands:**
```bash
npm run format         # Format all files
npm run format:check   # Check formatting without fixing
npm run lint           # Run ESLint
npm run lint:fix       # Run ESLint with auto-fix
```

## Behavioral invariants (don't break these)

- The first attempt skips the bulkhead; the bulkhead throttles retry traffic only.
- `retryWhen` is consulted after **every** failed attempt, including attempt 0.
- A failed `parse` (`ValidationError`) resolves immediately and is never retried.
- Cancellation wins over timeouts and retries; a cancelled ticket is never retried.
- `ticket.toPromise()` never rejects — failures are a `Result` union with a closed `RelayError` hierarchy.

See [AGENTS.md](./AGENTS.md) for more gotchas.
