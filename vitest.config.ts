import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		environment: "node",
		include: ["test/**/*.test.ts"],
		testTimeout: 15_000,
		coverage: {
			provider: "v8",
			reporter: ["text", "html", "lcov"],
			include: ["src/**"],
			// Just under the current numbers, so coverage can only ratchet up.
			// Raise them when a PR lifts coverage; don't lower them to land one.
			thresholds: {
				lines: 96,
				statements: 96,
				functions: 95,
				branches: 92,
				// The retry/queue core, where the B1–B17 bugs lived (#136).
				"src/queue/**": {
					branches: 95,
				},
			},
		},
	},
});
