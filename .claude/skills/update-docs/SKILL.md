---
name: update-docs
description: Review and update Vereda's hand-written documentation (README.md, AGENTS.md, ONBOARDING.md, CONTRIBUTING.md, GOOD_FIRST_ISSUES.md, docs/operations.md, CHANGELOG.md) after a code change so they stay accurate. Use before finishing/merging a branch that touches public API surface, behavior, invariants, config, or setup steps, or when asked to "update the docs" / "check docs are current". Does NOT touch the auto-generated API reference (TypeDoc via `npm run docs`, deployed by .github/workflows/docs.yml on every push to main) — that already stays current on its own.
---

# update-docs — keep the hand-written docs honest

GitHub Pages already redeploys the TypeDoc API reference automatically on every push to `main`. What doesn't self-update is the prose: README, architecture notes, onboarding path, contributor setup, the changelog. This skill's job is to catch drift between those docs and the code that just changed — not to write new docs from scratch.

## In scope
- `README.md` — usage examples, feature list, badges, `## Contents` index
- `AGENTS.md` — architecture, behavioral invariants, "key file per concern" map
- `ONBOARDING.md` — stop-by-stop reading path
- `CONTRIBUTING.md` — setup steps, commands
- `GOOD_FIRST_ISSUES.md` — verified starter tasks
- `docs/operations.md` — operations guide
- `CHANGELOG.md` — Keep a Changelog format, entries land under `[Unreleased]`

## Out of scope
- The TypeDoc API reference / GitHub Pages deploy — CI already handles this
- `CODE_OF_CONDUCT.md`, `SECURITY.md` — static policy, not tied to code changes

## Method
1. **Find what changed.** Diff the current branch against `main` (`git diff main...HEAD`), scoped to `src/`. Note: new/removed/renamed public exports, changed function signatures or options, new error types, changed invariants (e.g. retry/cancellation semantics), new/changed config, new npm scripts.
2. **Check CHANGELOG.md first.** If the change is user-visible, add an entry under `[Unreleased]` in the existing Added/Changed/Fixed/Removed style. This is almost never skippable.
3. **Walk the remaining in-scope docs one at a time.** For each, grep it for the changed symbols/behavior. If it references something that no longer matches the source, update it to match the source — never phrase a fix from memory, always re-read the actual code first. If a doc doesn't mention the changed area at all, leave it alone.
4. **Special case — GOOD_FIRST_ISSUES.md**: if this change fixes or removes a listed starter task, delete that entry. A stale "good first issue" that's already done is worse than no list.
5. **Special case — README `## Contents`**: each feature card summarizes its section in one line, so it drifts silently. If a change touches a feature the index describes (e.g. the circuit breaker stops being opt-in), update that card's line to match. If a heading is added, renamed, or removed, update its card or link and `#anchor`, then confirm every `](#...)` link in the README still resolves to a heading.
6. **Report a short summary**: which docs were edited and why, and which in-scope docs were checked but needed no change. Don't silently skip a doc — say you looked.

## Rules
- Never invent documentation content that isn't traceable to the actual source you just read this session.
- Prefer the smallest accurate diff over rewriting a section wholesale.
- If it's genuinely ambiguous whether a change is CHANGELOG-worthy (internal refactor vs. user-visible behavior change), ask rather than guessing.
- If a doc and the code already agree, don't touch it just to touch it.
