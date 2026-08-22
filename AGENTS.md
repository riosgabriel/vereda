# AGENTS.md

Relay: resilient HTTP client for Node.js (queuing, retries, bulkhead isolation) built on global `fetch`. ESM-only, Node 18+, zero runtime dependencies. Not published to npm (the `relay` npm name is an unrelated package); installed from GitHub, where the `prepare` script builds `dist/`.

## Commands

```bash
npm test                                        # vitest run (all tests)
npx vitest run test/queue/bulkhead.test.ts      # single test file
npx vitest run -t "name fragment"               # single test by name
npm run typecheck                               # tsc --noEmit
npm run build                                   # tsc -> dist/
```

There is no lint or formatter configured — don't invent or run one.

## Gotchas

- **NodeNext ESM**: every relative import in `src/` and `test/` must use the `.js` extension even when importing `.ts` files (`from "./client.js"`).
- **`npm run typecheck` skips test files**: tsconfig excludes `**/*.test.ts`, so nothing else typechecks them. Keep test code type-safe by running the tests.
- **Zod boundary**: zod is an optional peer dependency. Only `src/adapters/zod.ts` may import it; `src/core/` must stay zod-free.
- **`dist/` and `package-lock.json` are gitignored** build/local artifacts — never edit `dist/` or commit either.
- README prose can drift (e.g. it claims 36 tests; suite has 30). Trust code, config, and test output over README claims.

## Architecture

Three public entry points, mirrored by `package.json` `exports`:

| Export | Source | Notes |
| --- | --- | --- |
| `.` | `src/core/index.ts` | `HttpClient`, `Ticket`, error classes, types |
| `/middleware` | `src/middleware/index.ts` | onion middleware helpers |
| `/zod` | `src/adapters/zod.ts` | `withZod` adapter (only zod import site) |

Request flow: `client.get()` returns a `Ticket` synchronously → first attempt fires **outside** the bulkhead → only retries go through the per-host partition bulkhead (`src/queue/`). Behavioral invariants — preserve these when touching retry/queue logic:

- First attempt skips the bulkhead (bulkhead throttles retry traffic only).
- `retryWhen` is consulted after **every** failed attempt, including attempt 0.
- `ValidationError` (failed `parse`) resolves immediately and is never retried.
- Cancellation wins over timeouts/retries; a cancelled ticket is never retried.
- `ticket.toPromise()` never rejects — failures are a `Result` union with the closed `RelayError` hierarchy (`src/core/errors.ts`).

## Tests

- Self-contained: integration tests spin up `node:http` servers on `127.0.0.1` ephemeral ports. No network, services, or env vars needed.
- `testTimeout` is 15s (`vitest.config.ts`); retry/backoff tests use tiny delays (`baseDelayMs: 10`, `jitter: false`) — keep new timing-sensitive tests similarly fast.
