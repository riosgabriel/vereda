# AGENTS.md

Vereda: resilient HTTP client for Node.js (queuing, retries, bulkhead isolation) built on global `fetch`. ESM-only, Node 20+, zero runtime dependencies. Not published to npm; installed from GitHub, where the `prepare` script builds `dist/`.

## Commands

```bash
npm test                                        # vitest run (all tests)
bun run --bun test                              # same suite under Bun (CI's test-bun leg)
npm run test:watch                              # vitest watch mode
npx vitest run test/queue/bulkhead.test.ts      # single test file
npx vitest run -t "name fragment"               # single test by name
npm run typecheck                               # tsc --noEmit (src + tests)
npm run build                                   # tsc -> dist/
bun run check                                   # Biome lint + format + import order (the CI gate)
bun run check:fix                               # same, applying safe fixes
bun run format                                  # format all files with Biome
bun run format:check                            # check formatting without writing
bun run lint                                    # Biome lint only
bun run lint:fix                                # Biome lint with safe auto-fix
```

Biome is the sole linter/formatter (no ESLint, no Prettier). Run `bun run check:fix` before committing;
the pre-commit hook runs the same check over staged files.

**Never run `biome check --write --unsafe` on this repo without reading the diff.** Unsafe fixes have
been observed deleting the private `markQueued`/`markRetrying`/`markDone` mutators in
`src/ticket/ticket.ts` (Biome can't see they're reached via bracket notation) and no-opping the default
logger in `src/middleware/index.ts`. Both sites carry `biome-ignore` comments explaining why — leave them.

## Gotchas

- **NodeNext ESM**: every relative import in `src/` and `test/` must use the `.js` extension even when importing `.ts` files (`from "./client.js"`).
- **Test files are typechecked separately**: `tsconfig.json` excludes `**/*.test.ts` (it drives the `dist/` build, which must not contain tests). `tsconfig.test.json` covers `src/` + `test/` with `noEmit`, and `npm run typecheck` runs both, so test code is type-safe in CI.
- **Zod boundary**: zod is an optional peer dependency. Only `src/adapters/zod.ts` may import it; `src/core/` must stay zod-free.
- **`dist/` is a gitignored** build artifact — never edit `dist/`.
- **`bun.lock` is the only lockfile.** Install with `bun install`; CI uses `bun install --frozen-lockfile`. Do not run `npm install` — it ignores `bun.lock` and writes a `package-lock.json` (now gitignored). Note `bun install` also runs the root `prepare` script (`tsc && husky`), so installing builds `dist/`.
- **Two test runtimes.** CI runs the suite under Node 20/22/24 *and* under Bun. `bun run --bun test` reproduces the Bun leg — without `--bun`, bun respects the vitest shebang and silently runs under Node. Runtime-conditional expectations (currently only the TRACE row in `test/core/retry-matrix.test.ts`) key off a `Bun` global check; CI sets `EXPECTED_RUNTIME` on both legs so a leg that silently changes runtime fails instead of passing.
- README prose can drift (e.g. it claims N tests; suite has a different count). Trust code, config, and test output over README claims.

## Architecture

Three public entry points, mirrored by `package.json` `exports`:

| Export | Source | Notes |
| --- | --- | --- |
| `.` | `src/core/index.ts` | `HttpClient`, `Ticket`, error classes, types |
| `/middleware` | `src/middleware/index.ts` | onion middleware helpers |
| `/zod` | `src/adapters/zod.ts` | `withZod` adapter (only zod import site) |

Request flow: `client.get()` returns a `Ticket` synchronously → first attempt fires **outside** the bulkhead → only retries go through the per-host partition bulkhead (`src/queue/`). Behavioral invariants — preserve these when touching retry/queue logic:

- First attempt skips the bulkhead (bulkhead throttles retry traffic only).
- Default retry policy — only `network`/`timeout`/`retryable_status` errors on idempotent requests (or `retry.idempotent`/`Idempotency-Key` opt-in) are retried; user `retryWhen` is consulted after it and can only veto.
- `retryWhen` is consulted after **every** failed attempt, including attempt 0.
- `ValidationError` (failed `parse`) resolves immediately and is never retried.
- Cancellation wins over timeouts/retries; a cancelled ticket is never retried.
- Replayable bodies — body may be a factory invoked per attempt; a raw `ReadableStream` is a `ConfigurationError`.
- Retries honor `Retry-After` (seconds or HTTP-date) capped at `maxDelayMs`; backoff otherwise.
- `ticket.toPromise()` never rejects — failures are a `Result` union with the closed `RequestError` hierarchy (`src/core/errors.ts`).
- Graceful shutdown: `client.close({ drain: true, timeoutMs })` waits for in-flight tickets up to `timeoutMs`, then cancels remaining; `client.close()` without drain cancels immediately. New requests throw `ConfigurationError("client closed")`.
- Lifecycle events: `client.on(event, listener)` for `request`, `retry`, `success`, `failure`. The `retry` event fires with zero-based retry index (0 = first retry after initial attempt).
- `ticket.subscribe()` is an async generator yielding `TicketUpdate` events (`queued`, `retrying`, `done`, `cancelled`).

→ To onboard a contributor using this mental model, see **Onboarding contributors (for LLMs)** below and `ONBOARDING.md`.

## Tests

- Self-contained: integration tests spin up `node:http` servers on `127.0.0.1` ephemeral ports. No network, services, or env vars needed.
- `testTimeout` is 15s (`vitest.config.ts`); retry/backoff tests use tiny delays (`baseDelayMs: 10`, `jitter: false`) — keep new timing-sensitive tests similarly fast.

## Onboarding contributors (for LLMs)

An LLM can stand in for a library's docs website: interactively walk a new contributor through the internals so they can start contributing. Use this section plus the architecture and invariants above as the teaching mental model. Developers can invoke the `guide-me` skill to get this walkthrough interactively.

**Method**
1. Follow `ONBOARDING.md` stop-by-stop. At each stop, open the referenced source file and explain the *actual* code — read it, don't paraphrase from memory.
2. Convey the mental-model essentials below at the relevant stops.
3. After the tour, point to `CONTRIBUTING.md` for setup, commands, and how to make the first contribution.

**Mental-model essentials to convey**
- Request flow: `client.get()` returns a `Ticket` synchronously; the first attempt fires *outside* the bulkhead; only retries go through the per-host bulkhead (`src/queue/`).
- `retryWhen` is consulted after *every* failed attempt, including attempt 0.
- `ValidationError` (failed `parse`) resolves immediately and is never retried.
- Cancellation wins over timeouts/retries; a cancelled ticket is never retried.
- `ticket.toPromise()` never rejects — failures are a `Result` union with the closed `RequestError` hierarchy (`src/core/errors.ts`).

**Key file per concern** (for "where do I look?" questions)
- Public API / `Ticket` / errors: `src/core/` (`index.ts`, `client.ts`, `errors.ts`, `types.ts`)
- Ticket state machine: `src/ticket/ticket.ts`
- Single attempt + middleware composition: `src/queue/executor.ts`
- Retry loop: `src/queue/retry.ts`
- Retry policy + `shouldRetry`: `src/queue/policy.ts`
- Bulkhead + per-host queue: `src/queue/bulkhead.ts`
- Backoff: `src/core/backoff.ts`
- Config validation: `src/core/validate.ts`
- Ticket ID generation: `src/core/nanoid.ts`
- Middleware helpers: `src/middleware/index.ts`
- Zod adapter (only zod import site): `src/adapters/zod.ts`
