# Contributing to Vereda

Thanks for your interest! Vereda is a small, focused library, and we're glad to have help.

**New to the codebase?** You have two on-ramps: read [ONBOARDING.md](./ONBOARDING.md) for a self-guided tour that follows one request through the whole library, or run the **`guide-me`** skill in your harness (Claude Code, OpenCode, etc.) — it's bundled in `.opencode/skills/` and will walk you through the internals interactively.

## Setup

```bash
git clone https://github.com/riosgabriel/vereda.git
cd vereda
npm install
```

Requires Node 20+ (enforced via `engines` in package.json).

## Commands

```bash
npm test          # run the full suite (vitest)
npm run typecheck # tsc --noEmit
npm run build     # compile TypeScript to dist/
npm run format    # format all files with Biome
npm run lint      # lint with Biome
npm run check     # lint + format + import order — the same gate CI runs
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
- CI runs `bun run ci` (`biome ci --error-on-warnings`) over the whole tree — run `bun run check` before pushing.

## Code Style

[Biome](https://biomejs.dev) is the single source of truth for both formatting and linting — there is no
ESLint or Prettier config. Style is tabs, 120-column lines, double quotes, with imports auto-organized.

**Format on save:** install the Biome editor extension and set it as the default formatter. `.editorconfig`
is kept in sync with `biome.json`, so editors without the extension still indent correctly.

**Commands:**
```bash
bun run check          # Lint + format + import order (what CI enforces)
bun run check:fix      # Same, applying safe fixes
bun run format         # Format all files
bun run format:check   # Check formatting without fixing
bun run lint           # Lint only
bun run lint:fix       # Lint with safe auto-fix
```

Warnings fail the build (`--error-on-warnings`), so a lint warning is a lint error here — fix it or
suppress it deliberately with a `// biome-ignore lint/<rule>: <reason>` comment that says *why*.
The reason is required, and the comment must sit on the line immediately above the offending line.

**Avoid `--unsafe` fixes.** `biome check --write --unsafe` is known to break this codebase: it deletes
the private ticket mutators in `src/ticket/ticket.ts` and silently no-ops the logger middleware. If you
run it, read the diff carefully.

## Behavioral invariants (don't break these)

- The first attempt skips the bulkhead; the bulkhead throttles retry traffic only.
- `retryWhen` is consulted after **every** failed attempt, including attempt 0.
- A failed `parse` (`ValidationError`) resolves immediately and is never retried.
- Cancellation wins over timeouts and retries; a cancelled ticket is never retried.
- `ticket.toPromise()` never rejects — failures are a `Result` union with a closed `RequestError` hierarchy.

See [AGENTS.md](./AGENTS.md) for more gotchas.
