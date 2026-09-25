import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DEFAULT_BASE_DELAY_MS, DEFAULT_JITTER, DEFAULT_MAX_DELAY_MS } from "../../src/core/backoff.ts";
import {
	DEFAULT_CONCURRENCY,
	DEFAULT_GLOBAL_CONCURRENCY,
	DEFAULT_GLOBAL_QUEUE_SIZE,
	DEFAULT_MAX_QUEUE_SIZE,
	DEFAULT_MAX_RETRIES,
	DEFAULT_RETRY_ON_STATUS,
} from "../../src/core/types.ts";

const README = readFileSync(new URL("../../README.md", import.meta.url), "utf8");

/** Rows of the Quick start defaults table, keyed by the Setting column. */
function defaultsTable(): Map<string, string> {
	const heading = "| Setting | Default |";
	const start = README.indexOf(heading);
	expect(start, "README defaults table not found").toBeGreaterThan(-1);
	const rows = new Map<string, string>();
	for (const line of README.slice(start).split("\n").slice(2)) {
		if (!line.startsWith("|")) break;
		const [, setting, value] = line.split("|").map((cell) => cell.trim());
		rows.set(setting, value);
	}
	return rows;
}

describe("README defaults table", () => {
	it("matches the library's default constants", () => {
		const rows = defaultsTable();
		const row = (setting: string): string => {
			const value = rows.get(setting);
			expect(value, `missing row: ${setting}`).toBeDefined();
			return value as string;
		};

		expect(row("Retries")).toMatch(new RegExp(`^${DEFAULT_MAX_RETRIES} retries\\b`));
		expect(row("Retries")).toContain(`(${DEFAULT_MAX_RETRIES + 1} total executions)`);

		const backoff = row("Backoff");
		expect(backoff).toContain(`${DEFAULT_BASE_DELAY_MS}ms base`);
		expect(backoff).toContain(`${DEFAULT_MAX_DELAY_MS / 1000}s cap`);
		expect(backoff.includes("full jitter")).toBe(DEFAULT_JITTER);

		const statuses = row("Retry-on status codes").match(/`\[([^\]]+)\]`/)?.[1];
		expect(statuses?.split(",").map((s) => Number(s.trim()))).toEqual(DEFAULT_RETRY_ON_STATUS);

		expect(row("Per-partition concurrency")).toMatch(new RegExp(`^${DEFAULT_CONCURRENCY}\\b`));
		expect(row("Per-partition queue size")).toMatch(new RegExp(`^${DEFAULT_MAX_QUEUE_SIZE}\\b`));
		expect(row("Global concurrency")).toMatch(new RegExp(`^${DEFAULT_GLOBAL_CONCURRENCY}\\b`));
		expect(row("Global queue size")).toMatch(new RegExp(`^${DEFAULT_GLOBAL_QUEUE_SIZE}\\b`));
	});
});
