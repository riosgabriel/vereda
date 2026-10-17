import { describe, expect, it } from "vitest";

import {
	bookPin,
	checkChapter,
	findReferences,
	looksLikePath,
	type RepoView,
	resolvePath,
	staleChapters,
	symbolName,
} from "../../scripts/book-check.ts";

function fakeRepo(contents: Record<string, string>, ignored: string[] = []): RepoView {
	const files = Object.keys(contents);
	const dirs = new Set(
		files.flatMap((f) =>
			f
				.split("/")
				.slice(0, -1)
				.map((_, i, parts) => parts.slice(0, i + 1).join("/")),
		),
	);
	return {
		files,
		exists: (p) => p.replace(/\/$/, "") in contents || dirs.has(p.replace(/\/$/, "")),
		isFile: (p) => p in contents,
		read: (p) => contents[p] ?? "",
		isIgnored: (p) => ignored.includes(p),
	};
}

const repo = fakeRepo(
	{
		"src/core/client.ts": "export class HttpClient {\n  close() {}\n}\n",
		"src/core/types.ts": "export function isBoundedMs() {}\n",
		"src/queue/retry.ts": "export function runRetryLoop() {}\n",
		"test/core/types.ts": "",
		"package.json": "{}",
	},
	["dist/index.js"],
);

describe("looksLikePath", () => {
	it.each(["src/core/client.ts", "test/", "package.json", "README.md", "src/queue/retry.ts:42"])(
		"%s is a path",
		(t) => {
			expect(looksLikePath(t)).toBe(true);
		},
	);

	it.each([
		"ticket.cancel()",
		"@vereda/http/zod",
		"a/b testing",
		"json<T>()",
		"node:http",
		"https://example.com/x",
		"--frozen-lockfile",
		"ticket.status",
	])("%s is not a path", (t) => {
		expect(looksLikePath(t)).toBe(false);
	});
});

describe("findReferences", () => {
	it("pairs a path with its symbol and skips fenced code and ignored lines", () => {
		const md = [
			"See `src/queue/retry.ts` — `runRetryLoop()` and `package.json`.",
			"```ts",
			"import x from `src/nowhere.ts`;",
			"```",
			"A wrong path on purpose: `src/old.ts` <!-- check-refs: ignore -->",
		].join("\n");
		expect(findReferences(md)).toEqual([
			{ line: 1, path: "src/queue/retry.ts", symbol: "runRetryLoop" },
			{ line: 1, path: "package.json" },
		]);
	});
});

describe("symbolName", () => {
	it("keeps the last member and drops the call", () => {
		expect(symbolName("HttpClient.close()")).toBe("close");
	});
});

describe("resolvePath", () => {
	it("resolves a unique bare name and flags a shared one", () => {
		expect(resolvePath(repo, "retry.ts")).toBe("src/queue/retry.ts");
		expect(resolvePath(repo, "types.ts")).toBe("ambiguous");
		expect(resolvePath(repo, "gone.ts")).toBeUndefined();
	});
});

describe("checkChapter", () => {
	it("passes when every path and symbol exists", () => {
		const md =
			"`src/core/client.ts` — `HttpClient.close()` uses `types.ts` from `src/`; build output is `dist/index.js`.";
		expect(checkChapter(repo, "ch.md", md)).toEqual([]);
	});

	it("reports a missing path and a missing symbol with their line", () => {
		const md = "Intro.\n`src/core/gone.ts` and `src/queue/retry.ts` — `runRetryLoopV2`";
		expect(checkChapter(repo, "ch.md", md)).toEqual([
			"ch.md:2: `runRetryLoopV2` not found in src/queue/retry.ts",
			"ch.md:2: path not found: src/core/gone.ts",
		]);
	});

	it("treats URL paths and foreign module paths as not ours", () => {
		expect(checkChapter(repo, "ch.md", "`/users/42` like Go's `x/time/rate`")).toEqual([]);
	});
});

describe("bookPin", () => {
	it("reads the short SHA from the README", () => {
		expect(bookPin("> **Pinned commit:** this book describes `984abe7` (`984abe76a1…`)")).toBe("984abe7");
		expect(bookPin("no pin here")).toBeUndefined();
	});
});

describe("staleChapters", () => {
	const chapters = new Map([
		["05.md", "`src/queue/retry.ts` — `runRetryLoop` and `src/core/client.ts`"],
		["07.md", "`src/core/client.ts` — `HttpClient.close()`"],
		["02.md", "Everything lives in `src/queue/`."],
	]);

	it("separates chapters citing a changed symbol from those citing only a changed file", () => {
		const diffs = new Map([
			["src/queue/retry.ts", "@@ -1 +1 @@ export function runRetryLoop() {\n-  old\n+  new"],
			["src/core/client.ts", "@@ -5 +5 @@ class HttpClient {\n-  send() {}\n+  send(x) {}"],
		]);
		expect(staleChapters(repo, chapters, diffs)).toEqual(
			new Map([
				["05.md", { symbols: ["runRetryLoop (src/queue/retry.ts)"], files: ["src/core/client.ts"] }],
				["07.md", { symbols: [], files: ["src/core/client.ts"] }],
			]),
		);
	});

	it("ignores directory references and unchanged files", () => {
		expect(staleChapters(repo, chapters, new Map([["src/queue/other.ts", "+x"]]))).toEqual(new Map());
	});
});
