# The Vereda Book

A book about how `@vereda/http` works inside: what problem it solves, how one request travels
through it, the rules the code must keep, and how to change it safely.

> **Pinned commit:** this book describes `984abe7` (`984abe76a15dc68b2f51ad39ecdff3ac625f3e2d`,
> 2026-10-15, version 1.0.2 plus unreleased changes: retry budget, rate limiting, the per-partition
> opt-out, the 1.x deprecations and three bug fixes). Where the book and the code differ, trust the
> code. To see what changed since, run `git diff 984abe7..HEAD --stat -- src/`.

## Who it's for

- **The returning maintainer.** You own this code, but you no longer remember why it looks the
  way it does. The book spends most of its words on *why*: the commits, issues and bug labels
  (`B1`–`B17`, `#181`) that shaped each mechanism.
- **A new contributor.** You know TypeScript, `fetch`, promises and `AbortController`. You don't
  need to know anything about resilience patterns; each one is introduced when the code first
  needs it.

By the end you should be able to open any file in `src/`, say what job it does on the request's
path, name the invariants it must keep, and write a change with a test that proves it.

## How to read it

Read the chapters in order. Each one needs only the ones before it. Every chapter opens with a
**Crux**: the one question it answers. If you already know the answer, skim to the next.

Keep the repo open beside the book. Code listings are labelled with a file and a function name
(not line numbers, which go stale), so you can jump to the real thing. Each chapter ends with
**What must stay true** (the invariants for that part of the code) and **Try it** (exercises
against the real code). Do at least one exercise per chapter; reading about a retry loop and
watching one run are different kinds of knowing.

To run the exercises you need the repo set up as in [CONTRIBUTING.md](../../CONTRIBUTING.md)
(`bun install`, Node 22+).

The book doesn't repeat the user-facing docs. Where a chapter needs them, it links to them:
[README](../../README.md), the guides in [docs/guide/](../guide/), the
[operations guide](../operations.md), [AGENTS.md](../../AGENTS.md) and
[ONBOARDING.md](../../ONBOARDING.md).

## The running example

The book follows one request from chapter to chapter: you ask for user 42, and the server is
having a bad day. The first try hangs, the second answers 503, and the third works. Chapter 5
walks it end to end, and the subsystem chapters pick it up where they come in.

To run it yourself, save this as `example.mts` at the repo root (outside `src/` and `test/`)
and run `npx tsx example.mts`. Delete it when you're done.

```typescript
import { HttpClient, json } from "./src/core/index.ts";

let call = 0;
const fakeServer = async (_url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  call++;
  if (call === 1) {
    // Hang until the client gives up on this attempt.
    return new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason)));
  }
  if (call === 2) return new Response("busy", { status: 503 });
  return Response.json({ id: 42, name: "Ada" });
};

const api = HttpClient.create({
  baseUrl: "https://api.example.com",
  timeout: { attemptMs: 200 },
  fetch: fakeServer as typeof fetch,
});

const t0 = Date.now();
const log = (...args: unknown[]) => console.log(String(Date.now() - t0).padStart(5), ...args);
for (const e of ["request", "retry", "success", "failure", "cancelled"] as const) {
  api.on(e, (data) => log("event", e, data));
}

// Vereda's timers don't keep Node alive; without this the script can exit mid-request.
const keep = setInterval(() => {}, 1000);
const ticket = api.get("/users/42", { parse: json<{ id: number; name: string }>() });
log("get() returned", ticket.status);
ticket.on("update", (u) => log("update", u));
const result = await ticket.toPromise();
log("result", result);
clearInterval(keep);
```

## Chapter map

| # | Chapter | Crux | Main files |
| --- | --- | --- | --- |
| 1 | [Why Vereda exists](01-why-vereda.md) | What does Vereda do that a `fetch` call doesn't, and what did it decide not to do? | `README.md`, `src/core/types.ts` |
| 2 | [A map of the repository](02-repo-map.md) | Where does each piece live, and who is allowed to import whom? | `package.json`, `src/`, the tsconfigs |
| 3 | [Using Vereda from the outside](03-using-vereda.md) | What does a caller write, how is configuration layered, and what comes back? | `src/core/index.ts`, `src/core/client.ts`, `src/core/validate.ts` |
| 4 | [The ticket](04-the-ticket.md) | Why does a request return a `Ticket` instead of a promise, and what states can it be in? | `src/ticket/ticket.ts`, `src/core/listeners.ts` |
| 5 | [Life of a request](05-life-of-a-request.md) | What happens, step by step, between `client.get()` and the ticket settling? | `src/core/client.ts`, `src/queue/retry.ts` |
| 6 | [One attempt](06-one-attempt.md) | How does one attempt turn a `fetch` into exactly one of four outcomes, and how is it guaranteed to end? | `src/queue/executor.ts` |
| 7 | [Deciding to retry](07-deciding-to-retry.md) | Which failures are retried, how long does Vereda wait, and which error does the caller finally see? | `src/queue/policy.ts`, `src/core/backoff.ts`, `src/core/errors.ts` |
| 8 | [Isolation: bulkheads, the global cap and the rate limiter](08-isolation.md) | How does Vereda keep one bad host from eating everyone else's capacity? | `src/queue/bulkhead.ts`, `src/queue/semaphore.ts`, `src/queue/rate-limiter.ts` |
| 9 | [Failing fast: the circuit breaker and the retry budget](09-failing-fast.md) | How does Vereda decide to stop calling a host, or stop retrying it? | `src/queue/circuit-breaker.ts`, `src/queue/retry-budget.ts` |
| 10 | [Observability and extension points](10-observability-and-extensions.md) | How does information leave the client, and how can user code plug in without being able to break it? | `src/core/listeners.ts`, `src/core/metrics.ts`, `src/core/redact.ts`, `src/middleware/index.ts`, `src/otel/index.ts` |
| 11 | [The rules and the bugs that taught them](11-rules-and-bugs.md) | What must stay true whenever you change this code, and how was each rule learned? | the whole spine |
| 12 | [How the project checks itself](12-testing-and-release.md) | How do I prove a change is correct, and how does it get shipped? | `test/`, `vitest.config.ts`, `.github/workflows/` |
| 13 | [Open problems](13-open-problems.md) | What is still unsolved, and which chapters do I need to solve it? | open issues |
| — | [Glossary](glossary.md) | | |

## The one picture to keep in mind

```mermaid
flowchart LR
  call["client.get()"] --> ticket["Ticket returned at once"]
  call --> first["first attempt<br/>(skips the partition bulkhead)"]
  first -->|success| done["ticket settles"]
  first -->|non-retryable or vetoed| done
  first -->|transient failure| loop["retry loop<br/>(every retry goes through<br/>the partition bulkhead)"]
  loop -->|success, veto, exhaustion,<br/>cancel or deadline| done
```

*What to notice: the caller gets the ticket before any network work happens, and only retries
queue behind the per-host bulkhead. Chapter 5 fills in every box.*
