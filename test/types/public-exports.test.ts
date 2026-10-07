import { describe, expectTypeOf, it } from "vitest";
import { type BulkheadSnapshot, HttpClient } from "../../src/core/index.ts";

// Type-level only: these assertions are checked by `npm run typecheck`.
describe("public exports", () => {
	it("names the partitions() snapshot type", () => {
		const client = HttpClient.create({ timeout: { attemptMs: 1_000 } });
		expectTypeOf(client.partitions()).toEqualTypeOf<BulkheadSnapshot[]>();
	});
});
