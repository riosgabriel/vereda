import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const README = readFileSync(new URL("../../README.md", import.meta.url), "utf8");
const GUIDE = readFileSync(new URL("../../docs/guide/comparison.md", import.meta.url), "utf8");

/** The comparison table's rows, from its header line to the first non-table line. */
function table(doc: string): string[] {
	const start = doc.indexOf("| | Vereda |");
	expect(start, "comparison table not found").toBeGreaterThan(-1);
	const rows: string[] = [];
	for (const line of doc.slice(start).split("\n")) {
		if (!line.startsWith("|")) break;
		rows.push(line);
	}
	return rows;
}

/** The "Checked against … in <Month Year>" sentence, which names each library's version. */
function checkedAgainst(doc: string): string | undefined {
	return /Checked against .+? in \w+ \d{4}/.exec(doc)?.[0];
}

// The README and the comparison guide both carry the table, so a re-check updates both or neither.
describe("comparison table", () => {
	it("is the same in the README and the comparison guide", () => {
		expect(table(GUIDE)).toEqual(table(README));
	});

	it("names the same checked versions in both", () => {
		expect(checkedAgainst(README)).toBeDefined();
		expect(checkedAgainst(GUIDE)).toBe(checkedAgainst(README));
	});
});
