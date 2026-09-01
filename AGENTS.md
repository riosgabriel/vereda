# AGENTS.md

Vereda: resilient HTTP client for Node.js (queuing, retries, bulkhead isolation) built on global `fetch`. ESM-only, Node 18+, zero runtime dependencies. Not published to npm; installed from GitHub, where the `prepare` script builds `dist/`.

## Commands

```bash
npm test                                        # vitest run (all tests)
npx vitest run test/queue/bulkhead.test.ts      # single test file
npx vitest run -t "name fragment"               # single test by name
npm run typecheck                               # tsc --noEmit
npm run build                                   # tsc -> dist/
npm run format                                  # format all files with Prettier
npm run lint                                    # run ESLint
```

Prettier and ESLint are configured. Run `npm run format` and `npm run lint:fix` before committing.

## Gotchas

- **NodeNext ESM**: every relative import in `src/` and `test/` must use the `.js` extension even when importing `.ts` files (`from "./client.js"`).
- **`npm run typecheck` skips test files**: tsconfig excludes `**/*.test.ts`, so nothing else typechecks them. Keep test code type-safe by running the tests.
- **Zod boundary**: zod is an optional peer dependency. Only `src/adapters/zod.ts` may import it; `src/core/` must stay zod-free.
- **`dist/` is a gitignored** build artifact — never edit `dist/`.
- `package-lock.json` is committed (npm is the package manager). CI uses `npm ci`.
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
- `ticket.toPromise()` never rejects — failures are a `Result` union with the closed `RequestError` hierarchy (`src/core/errors.ts`).

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
- Bulkhead + per-host queue: `src/queue/bulkhead.ts`
- Backoff: `src/core/backoff.ts`
- Middleware helpers: `src/middleware/index.ts`
- Zod adapter (only zod import site): `src/adapters/zod.ts`
