// The trace is the contract between whatever produces a demo run and the
// shared player that draws it. Today the producers are the hand-written
// `simulate()` functions inside each page; later a build script will run the
// real HttpClient under a virtual clock and write the same shape to JSON.
// The player only ever reads a trace, so swapping the producer changes
// nothing on screen.
//
// What the six pages draw today, and so what a trace must be able to say:
//
//   retry-budget     per-tick aggregates: load, retries, served, refused, capacity
//   circuit-breaker  one record per request (sent, ended, outcome, was it a trial)
//                    plus breaker state changes with a reason
//   backoff-jitter   one record per attempt (client, attempt number, time, result)
//   bulkhead         one record per request with queue/slot/permit timestamps
//   timeouts         one record per attempt (start, end, why it ended) plus the
//                    moment the caller hears back and with which error kind
//   rate-limiter     one record per attempt (token wait, sent, outcome) plus the
//                    bucket level over time
//
// Every page also has two lanes ("without" and "with" the pattern) and a
// scenario timeline (named phases such as "healthy", "host slow", "fixed").
// Times are sim seconds from the start of the run.

// Shape: records for attempts (what five pages draw as dots and bars), plus
// `states` for discrete changes and `series` for levels over time. Neither of
// those fits a record, and the retry budget's aggregates live in `series`.

/**
 * @typedef {object} DemoTrace
 * @property {1} version Bumped on any breaking change to this shape.
 * @property {string} pattern e.g. "circuit-breaker"; matches the page file name.
 * @property {number} duration Sim seconds the run lasts.
 * @property {Phase[]} phases The scenario timeline, in order, covering 0..duration.
 * @property {Moment[]} [moments] Key events worth slowing down for, sorted by t.
 * @property {{ without: LaneTrace, with: LaneTrace }} lanes Same traffic, without and with the pattern.
 */

/**
 * @typedef {object} Phase
 * @property {number} from
 * @property {number} to
 * @property {string} label e.g. "Host slow · serves 60/s"
 * @property {"good" | "bad" | "busy"} tone Colours the timeline segment.
 * @property {string} [caption] What to notice in this phase. The player shows it
 *   when playback reaches `from`, and in guided mode slows down there briefly.
 */

/**
 * @typedef {object} Moment
 * @property {number} t
 * @property {string} label What just happened, e.g. "Breaker opened: 5 failures in a row".
 *   Shown under the phase caption for a few seconds; in guided mode the player
 *   slows down just before and after `t`.
 */

/**
 * @typedef {object} LaneTrace
 * @property {string} config The config this lane ran with, shown as a snippet.
 * @property {Attempt[]} attempts Sorted by `sent`. Empty for aggregate-only pages.
 * @property {Result[]} results When each caller heard back, and how.
 * @property {StateChange[]} [states] Discrete changes, e.g. the breaker's closed/open/half-open.
 * @property {Record<string, Array<[number, number]>>} [series] Levels over time as [t, value],
 *   e.g. `load`, `capacity`, `tokens`, `permitsHeld`. Sorted by t.
 */

/**
 * @typedef {object} Attempt
 * @property {number} request Which request this attempt belongs to.
 * @property {number} n 0 for the first attempt, 1 for the first retry, and so on.
 * @property {number} sent When the client wanted to send it.
 * @property {number | null} start When it reached the host; null if it never did
 *   (rejected by an open breaker, a full queue, the retry budget or the rate limit).
 * @property {number} end When the attempt finished, from the client's side.
 * @property {"ok" | "error" | "timeout" | "aborted" | "rejected" | "hang"} outcome "hang" means it
 *   was still waiting when the run ended (no timeout set); `end` is then the run's end.
 * @property {string} [reason] The detail behind the outcome: a status ("429"),
 *   or what rejected it ("circuit_open", "queue_full", "budget", "rate_limited").
 * @property {string} [partition] Which partition it ran in, when a page has more than one.
 * @property {number} [slot] When it took a partition slot (bulkhead with `limitFirstAttempts`),
 *   whether it waited for one or not. Before `slot` it waits in the partition queue; between
 *   `slot` and `start` it holds the slot and waits for a global permit.
 * @property {boolean} [trial] A half-open trial request.
 * @property {number} [hostEnd] When the host stopped working on it, if later than `end`.
 */

/**
 * @typedef {object} Result
 * @property {number} request
 * @property {number} t When the caller heard back.
 * @property {boolean} ok
 * @property {string} [error] The error `kind` the caller got, e.g. "deadline", "max_retries".
 */

/**
 * @typedef {object} StateChange
 * @property {number} t
 * @property {string} state
 * @property {string} [reason] Why, in words a reader understands ("5 failures in a row").
 */

export {};
