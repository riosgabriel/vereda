import { describe, expect, it } from "vitest";
import type { BulkheadSnapshot } from "../../src/core/index.ts";
import { HttpClient } from "../../src/core/index.ts";

describe("public exports", () => {
	it("re-exports BulkheadSnapshot from core", () => {
		const client = HttpClient.create({ timeout: { attemptMs: 1_000 } });
		const partitions: BulkheadSnapshot[] = client.partitions();

		const snapshot: BulkheadSnapshot = {
			name: "host",
			running: 0,
			queued: 0,
			concurrency: 1,
			maxQueueSize: 5,
		};

		expect(Array.isArray(partitions)).toBe(true);
		expect(snapshot.name).toBe("host");
	});
});
