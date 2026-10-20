/** The interactive demos in site/demos/, served at /patterns/<file>. */
export const PATTERNS = [
	{
		file: "timeouts.html",
		title: "Timeouts",
		blurb: "Per-attempt timeout or total deadline? What `attemptMs` and `totalMs` each protect you from.",
	},
	{
		file: "backoff-jitter.html",
		title: "Backoff and jitter",
		blurb: "Why clients that retry on the same schedule come back together, and how full jitter spreads them out.",
	},
	{
		file: "retry-budget.html",
		title: "Retry budget",
		blurb: "How plain retries keep a slow host down after it recovers, and how a budget caps the extra load.",
	},
	{
		file: "circuit-breaker.html",
		title: "Circuit breaker",
		blurb: "What happens to callers when a host goes down, with and without a breaker that fails fast.",
	},
	{
		file: "bulkhead.html",
		title: "Bulkhead",
		blurb:
			"A slow service fills the shared global limit and blocks a fast one. A partition limit for the slow one keeps the fast one working.",
	},
	{
		file: "rate-limiter.html",
		title: "Rate limiter",
		blurb:
			"A burst of 100 requests hits an API that allows 20 per second and answers 429. A token bucket spreads the burst out instead.",
	},
] as const;
