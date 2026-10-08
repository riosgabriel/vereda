# Contributing to Vereda

Thanks for your interest! Vereda is a small, focused library, and we're glad to have help.

**New to the codebase?** You have two on-ramps: read [ONBOARDING.md](./ONBOARDING.md) for a self-guided tour that follows one request through the whole library, or run the **`guide-me`** skill in your harness (Claude Code, OpenCode, etc.) — it's bundled in `.claude/skills/` and will walk you through the internals interactively.

## Setup

```bash
git clone https://github.com/riosgabriel/vereda.git
cd vereda
bun install
npx husky
```

`bun.lock` is the only lockfile — install with Bun so you get the same
dependency tree CI does. Requires Node 22+ (enforced via `engines` in
package.json); the library itself is runtime-agnostic and CI tests it under
both Node and Bun.

`npx husky` is a one-time step that wires up the pre-commit hook in
`.husky/`. It used to run automatically via the `prepare` script, but
`prepare` also ran `tsc` on every install (needed when the package was
installed straight from GitHub) — now that the package publishes a
prebuilt `dist/` to npm, `prepare` would force every consumer to compile
the library on install, so it's gone. Run `npx husky` once after cloning
to get the local git hook; nothing else in this section depends on it.

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

CI also runs the suite under the Bun runtime. To reproduce that leg locally:

```bash
bun run --bun test    # the --bun is load-bearing
```

Without `--bun`, `bun run test` respects the vitest shebang and silently runs
under Node, so it will not reproduce a Bun-only failure.

Tests are self-contained: integration tests spin up `node:http` servers on ephemeral localhost ports. No network, services, or env vars needed. Keep timing-sensitive tests fast — the suite uses tiny backoff delays (e.g. `baseDelayMs: 10`, `jitter: false`).

## API reference site

`npm run docs` generates the TypeDoc reference into `docs-site/`. On every push to `main`, `.github/workflows/docs.yml` builds it and deploys it to [GitHub Pages](https://riosgabriel.github.io/vereda/).

The repo's Pages source (Settings → Pages → Build and deployment) must stay set to **GitHub Actions**. If it's set to "Deploy from a branch" (`main` `/docs`), Pages serves the hand-written `docs/` folder, which has no `index.html`, and the site 404s even though the workflow passes. To check the setting and fix it:

```bash
gh api repos/riosgabriel/vereda/pages -q .build_type          # expect: workflow
gh api -X PUT repos/riosgabriel/vereda/pages -f build_type=workflow
```

## Before you open a PR

- Follow the existing patterns in the codebase.
- Preserve the behavioral invariants below — they're load-bearing.
- Every relative import must use the real `.ts` extension (`from "./client.ts"`). `tsc` rewrites it to `.js` on build.
- `npm run typecheck` runs three legs: `src/` (via `tsconfig.json`, which excludes `**/*.test.ts` so tests stay out of `dist/`), then `src/` + `test/` + `scripts/` + `vitest.config.ts` (via `tsconfig.test.json`), then `examples/` (via `examples/tsconfig.json`). Example code is held to the same types as the library.
- Zod is an optional peer dependency. Only `src/adapters/zod.ts` may import it; `src/core/` must stay zod-free.
- CI runs `bun run ci` (`biome ci --error-on-warnings`) over the whole tree — run `bun run check` before pushing.

## AI-assisted and automated contributions

Using AI tools to write code is fine — the bundled `guide-me` skill exists for exactly that. What we ask:

- **A human is accountable for the PR.** You've read the diff, you understand it, and you'll answer review comments yourself.
- **Say so in the PR description** if a tool wrote most of it. It doesn't change how the PR is judged; it helps the reviewer know where to look.
- **Good first issues are for people.** They exist to onboard contributors who'll stick around. Please don't point an agent at the `good first issue` label and open PRs in bulk.

PRs from accounts that look fully automated (bulk drive-by PRs across many repositories, no engagement in review) may be closed without review, or merged on their merits at the maintainer's discretion. Either way, the account may not get further good-first-issue PRs reviewed.

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
- The opt-in per-partition circuit breaker is checked before the bulkhead, before the first attempt, **and again before every retry** — while open it rejects with `CircuitOpenError` and nothing is attempted.
- `retryWhen` is consulted after **every** failed attempt that could still be retried, including attempt 0. Not called after the final attempt when no retries remain.
- A failed `parse` (`ValidationError`) resolves immediately and is never retried.
- Cancellation wins over timeouts and retries; a cancelled ticket is never retried.
- `ticket.toPromise()` never rejects — failures are a `Result` union with a closed `RequestError` hierarchy.

See [AGENTS.md](./AGENTS.md) for more gotchas.

## Releasing (maintainers)

Releases publish `@vereda/http` to npm from `.github/workflows/release.yml` using **npm Trusted Publishing**: GitHub Actions authenticates with a short-lived OIDC token, so no npm token is stored in the repo, and every version gets a provenance attestation automatically. The trusted publisher is configured on npmjs.com for this repo and the `release.yml` filename, so renaming the workflow breaks publishing until the npm setting is updated.

The trusted publisher may only **stage** versions (npm staged publishing): CI uploads the version, and it goes live only after a maintainer approves it with 2FA. Approving needs npm >= 11.15.0 and an npm account with 2FA.

**A release is a merged version bump.** When `main` gets a `package.json` version that has no `vX.Y.Z` tag yet, the workflow releases it. Feature PRs only add entries under `## [Unreleased]` in `CHANGELOG.md` and never touch `version`, so merging them releases nothing. You decide when to ship and which version by opening the release PR.

1. Run `npm run release:prepare` on an up-to-date `main`. It reads `[Unreleased]` and bumps `version` by the smallest amount the entries call for: `### Fixed` only → patch, any `### Added`/`### Changed`/`### Deprecated` → minor, `### Removed` → major. It also turns `## [Unreleased]` into `## [X.Y.Z] - <today>` and updates the compare links. Pass `patch`, `minor`, `major` or an exact `X.Y.Z` to choose the version yourself. It refuses a bump smaller than the entries call for unless you add `--force`, and refuses an empty `[Unreleased]`.
2. Open the release PR with the commands it prints. Optional: run the **Release** workflow manually with `dry_run: true` on that branch to preview the notes and the `npm pack` file list.
3. Merge it. The workflow typechecks, tests, builds, runs publint and attw, stages the version on npm, then creates the `vX.Y.Z` tag and the GitHub Release at the merged commit. A `package.json` change whose version is already tagged (e.g. a dependency bump) skips all of this.
4. Approve the staged version: `npm stage list`, check it with `npm stage view <stage-id>`, then `npm stage approve <stage-id>` (asks for 2FA). You can also approve it on npmjs.com. Until you do, the version isn't installable.

Don't push `v*` tags by hand: the workflow creates the tag, and a hand-pushed tag no longer starts a release.

Re-running a release is safe: the publish step skips a version that's already live on npm and continues to the GitHub Release. A version that's staged but not yet approved isn't live, so approve or reject it (`npm stage reject <stage-id>`) before re-running.
