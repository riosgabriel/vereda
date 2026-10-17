/**
 * Keeps docs/book honest about the code it describes.
 *
 *   npm run book:check    # every path and `path` — `symbol` pair the book cites must exist
 *   npm run book:drift    # which chapters cite source files changed since the book's pinned commit
 *
 * `book:check` runs in CI, so a PR that renames or deletes something the book cites fails and
 * names the chapter. `book:drift` is informational: release:prepare prints it, and a chapter it
 * lists is a candidate for an update (rewrite it, re-verify it, then move the pin in
 * docs/book/README.md).
 *
 * In a chapter, a line containing <!-- check-refs: ignore --> is skipped, for deliberate examples
 * of wrong paths. Code inside ``` fences is never checked.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const BOOK_DIR = "docs/book";

const INLINE_CODE = /`([^`\n]+)`/g;
// `path` — `symbol`, with an em dash, en dash, hyphen or arrow between them.
const PATH_SYMBOL = /`([^`\n]+)`\s*(?:—|–|-|→|->)\s*`([^`\n]+)`/g;
const LINE_SUFFIX = /:\d+(?:-\d+)?$/;
const IGNORE_MARKER = "<!-- check-refs: ignore -->";
const PIN = /this book describes `([0-9a-f]{7,40})`/;
// A slash-free token is a file name only with one of these (`package.json`), not member access (`ticket.cancel`).
const FILE_EXTENSIONS = new Set([
	"cjs",
	"js",
	"json",
	"jsonc",
	"lock",
	"md",
	"mjs",
	"sh",
	"toml",
	"ts",
	"tsx",
	"yaml",
	"yml",
]);

/** What the checks need from a checkout. Tests pass a fake; `gitRepo` reads a real one. */
export interface RepoView {
	/** Tracked and untracked-but-not-ignored files, relative to the root. */
	files: readonly string[];
	exists(path: string): boolean;
	isFile(path: string): boolean;
	read(path: string): string;
	isIgnored(path: string): boolean;
}

export interface Reference {
	line: number;
	path: string;
	symbol?: string;
}

/** Whether an inline code span names a repo path: `src/core/client.ts`, `test/`, `README.md`. */
export function looksLikePath(token: string): boolean {
	const t = token.trim().replace(LINE_SUFFIX, "");
	// Code, prose, package specifiers, URLs, flags and generics are never paths.
	if (t === "" || /[ ()<>@*{}=,;'"]/.test(t) || t.includes("://")) return false;
	if (t.startsWith("-") || t.startsWith("node:") || t.startsWith("npm:")) return false;
	if (t.includes("/")) return true;
	const dot = t.lastIndexOf(".");
	return dot > 0 && FILE_EXTENSIONS.has(t.slice(dot + 1).toLowerCase());
}

/** `HttpClient.request()` → `request`. */
export function symbolName(token: string): string {
	return (
		token
			.trim()
			.replace(/\(.*\)$/, "")
			.split(".")
			.at(-1) ?? ""
	);
}

/** Every path a chapter cites outside code fences, with the symbol when it's a `path` — `symbol` pair. */
export function findReferences(markdown: string): Reference[] {
	const refs: Reference[] = [];
	let inFence = false;
	markdown.split("\n").forEach((text, i) => {
		if (text.trimStart().startsWith("```")) {
			inFence = !inFence;
			return;
		}
		if (inFence || text.includes(IGNORE_MARKER)) return;
		const line = i + 1;
		const paired = new Set<string>();
		for (const [, path, symbol] of text.matchAll(PATH_SYMBOL)) {
			if (!looksLikePath(path)) continue;
			refs.push({ line, path: path.replace(LINE_SUFFIX, ""), symbol: symbolName(symbol) });
			paired.add(path);
		}
		for (const [, token] of text.matchAll(INLINE_CODE)) {
			if (looksLikePath(token) && !paired.has(token)) refs.push({ line, path: token.replace(LINE_SUFFIX, "") });
		}
	});
	return refs;
}

/**
 * The repo file a chapter means by `path`. A bare name (`types.ts`) resolves when exactly one
 * file has it. Returns "ambiguous" when several do (the prose disambiguates), undefined when none.
 */
export function resolvePath(repo: RepoView, path: string): string | "ambiguous" | undefined {
	if (repo.exists(path)) return path;
	if (path.replace(/\/$/, "").includes("/")) return undefined;
	const matches = repo.files.filter((f) => f === path || f.endsWith(`/${path}`));
	if (matches.length > 1) return "ambiguous";
	return matches[0];
}

/** `x/time/rate`, `github.com/foo/bar`: no extension, and the first segment isn't in this repo. */
function isForeignSpecifier(repo: RepoView, path: string): boolean {
	const last = path.replace(/\/$/, "").split("/").at(-1) ?? "";
	const first = path.replace(/^[./]+/, "").split("/")[0];
	return !last.includes(".") && !path.endsWith("/") && !repo.exists(first);
}

/** One line per broken reference, as `chapter.md:line: problem`. Empty when the chapter is clean. */
export function checkChapter(repo: RepoView, name: string, markdown: string): string[] {
	const failures: string[] = [];
	for (const ref of findReferences(markdown)) {
		if (isForeignSpecifier(repo, ref.path) || repo.isIgnored(ref.path)) continue;
		const target = resolvePath(repo, ref.path);
		if (target === "ambiguous") continue;
		if (target === undefined) {
			failures.push(`${name}:${ref.line}: path not found: ${ref.path}`);
			continue;
		}
		if (ref.symbol === undefined || !repo.isFile(target)) continue;
		if (!wordIn(ref.symbol, repo.read(target))) {
			failures.push(`${name}:${ref.line}: \`${ref.symbol}\` not found in ${ref.path}`);
		}
	}
	return failures;
}

/** The short SHA the book's README says it describes, or undefined if it states none. */
export function bookPin(readme: string): string | undefined {
	return PIN.exec(readme)?.[1];
}

export interface Drift {
	/** `symbol (path)` for each cited symbol that appears in its file's diff: the chapter likely needs a rewrite. */
	symbols: string[];
	/** Changed files the chapter cites, with no cited symbol in the diff: worth a skim. */
	files: string[];
}

/**
 * How each chapter is touched by a diff. `diffs` maps each changed file to its diff text (changed
 * lines and hunk headers, which name the enclosing function). Only file references count: a
 * directory like `src/queue/` would make the repo-map chapter stale on every change.
 */
export function staleChapters(
	repo: RepoView,
	chapters: ReadonlyMap<string, string>,
	diffs: ReadonlyMap<string, string>,
): Map<string, Drift> {
	const stale = new Map<string, Drift>();
	for (const [name, markdown] of chapters) {
		const symbols = new Set<string>();
		const files = new Set<string>();
		for (const ref of findReferences(markdown)) {
			const target = resolvePath(repo, ref.path);
			if (target === undefined || target === "ambiguous") continue;
			const diff = diffs.get(target);
			if (diff === undefined) continue;
			files.add(target);
			if (ref.symbol !== undefined && wordIn(ref.symbol, diff)) symbols.add(`${ref.symbol} (${target})`);
		}
		for (const s of symbols) files.delete(s.slice(s.indexOf("(") + 1, -1));
		if (files.size > 0 || symbols.size > 0) stale.set(name, { symbols: [...symbols].sort(), files: [...files].sort() });
	}
	return stale;
}

function wordIn(word: string, text: string): boolean {
	return new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(text);
}

export function gitRepo(root: string): RepoView {
	const git = (...args: string[]) =>
		execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
	const files = git("ls-files", "--cached", "--others", "--exclude-standard").split("\n").filter(Boolean);
	return {
		files,
		exists: (p) => existsSync(join(root, p)),
		isFile: (p) => existsSync(join(root, p)) && statSync(join(root, p)).isFile(),
		read: (p) => readFileSync(join(root, p), "utf8"),
		isIgnored: (p) => {
			try {
				git("check-ignore", "-q", "--no-index", p);
				return true;
			} catch {
				return false;
			}
		},
	};
}

/** The book's Markdown files by name, in reading order. */
export function readBook(root: string): Map<string, string> {
	const dir = join(root, BOOK_DIR);
	if (!existsSync(dir)) return new Map();
	const names = readdirSync(dir)
		.filter((f) => f.endsWith(".md"))
		.sort();
	return new Map(names.map((n) => [n, readFileSync(join(dir, n), "utf8")]));
}

/** The drift report as printable lines, or undefined when there's no book or no pin. */
export function driftReport(root: string): string[] | undefined {
	const book = readBook(root);
	const pin = bookPin(book.get("README.md") ?? "");
	if (pin === undefined) return undefined;
	const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });
	const changed = git("diff", "--name-only", `${pin}..HEAD`, "--", "src").split("\n").filter(Boolean);
	const diffs = new Map(changed.map((f) => [f, git("diff", "-U0", `${pin}..HEAD`, "--", f)]));
	const stale = staleChapters(gitRepo(root), book, diffs);
	if (stale.size === 0)
		return [`The book (pinned at ${pin}) cites none of the ${changed.length} src files changed since.`];
	const strong = [...stale].filter(([, d]) => d.symbols.length > 0);
	const weak = [...stale].filter(([, d]) => d.symbols.length === 0).map(([name]) => name);
	return [
		`The book is pinned at ${pin}; ${changed.length} src files changed since.`,
		...(strong.length > 0 ? ["Chapters citing a changed symbol (likely need an update):"] : []),
		...strong.map(([name, d]) => `  ${name}: ${d.symbols.join(", ")}`),
		...(weak.length > 0 ? [`Chapters citing only a changed file (skim): ${weak.join(", ")}`] : []),
		`Update them, re-verify, then move the pin in ${BOOK_DIR}/README.md.`,
	];
}

function main(argv: string[]): number {
	if (argv[0] === "drift") {
		console.log((driftReport(".") ?? [`No pinned commit found in ${BOOK_DIR}/README.md.`]).join("\n"));
		return 0;
	}
	const repo = gitRepo(".");
	const book = readBook(".");
	const failures = [...book].flatMap(([name, markdown]) => checkChapter(repo, name, markdown));
	for (const f of failures) console.error(f);
	console.log(
		failures.length > 0
			? `${failures.length} broken reference(s) in ${BOOK_DIR}`
			: `${book.size} book files: all references resolve`,
	);
	return failures.length > 0 ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	try {
		process.exit(main(process.argv.slice(2)));
	} catch (err) {
		console.error(`book-check: ${err instanceof Error ? err.message : String(err)}`);
		process.exit(1);
	}
}
