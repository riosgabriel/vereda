// The library runs on a whole-millisecond clock: Date.now() is an integer, and
// setTimeout truncates its delay and waits at least 1 ms. Demo models that are
// checked against the library (test/demos/*.parity.test.ts) keep their times on
// the same grid, or borderline decisions come out differently: a request at the
// edge of a calendar second or of maxWaitMs, or two events in the same ms.

/** Seconds to whole milliseconds, as Date.now() would read them. */
export const toMs = (sec) => Math.round(sec * 1000);

/** Seconds, snapped to the millisecond grid. */
export const onMsGrid = (sec) => toMs(sec) / 1000;

/** What setTimeout really waits for a delay of `ms`: truncated, and at least 1 ms. */
export const timerDelay = (ms) => Math.max(1, Math.trunc(ms));
