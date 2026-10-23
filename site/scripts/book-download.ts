// Builds the Vereda Book as one EPUB and one PDF into public/downloads/, which the sidebar links
// to. Needs pandoc on PATH and Playwright's Chromium (`bunx playwright install chromium`), which
// renders the Mermaid diagrams to SVG and prints the PDF. Run before `astro build`:
// `bun scripts/book-download.ts`.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { routeFor } from "../src/doc-ids.ts";

const REPO_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const BOOK = join(REPO_ROOT, "docs/book");
const OUT = fileURLToPath(new URL("../public/downloads/", import.meta.url));
const MERMAID = fileURLToPath(new URL("../node_modules/mermaid/dist/mermaid.min.js", import.meta.url));
const PRINT_CSS = fileURLToPath(new URL("./book-print.css", import.meta.url));
const COVER = fileURLToPath(new URL("./book-cover.html", import.meta.url));

// Fail before the slow part (Chromium, diagrams) rather than with a spawn stack trace after it.
try {
	execFileSync("pandoc", ["--version"], { stdio: "ignore" });
} catch {
	console.error("pandoc is not on PATH. Install it (https://pandoc.org/installing.html, 3.1 or later) and run again.");
	process.exit(1);
}

// The README opens the book, the numbered chapters follow in order, the glossary closes it.
const chapters = [
	"README.md",
	...readdirSync(BOOK)
		.filter((f) => /^\d+-.+\.md$/.test(f))
		.sort(),
	"glossary.md",
];

// The book describes one commit (README, "Pinned commit"); a download is a snapshot of it.
const pin = readFileSync(join(BOOK, "README.md"), "utf8").match(/Pinned commit:.*?`([0-9a-f]{40})`/s)?.[1];
if (!pin) throw new Error("docs/book/README.md: no 40-character pinned commit found");

/** The id given to a chapter's title, so links between chapters become links inside the file. */
const chapterId = (file: string) => `ch-${file.replace(/\.md$/, "").toLowerCase()}`;

/**
 * Where a link to `repoPath` (relative to the repo root, no anchor) should point from inside the
 * downloaded book, where relative links lead nowhere.
 */
function bookHref(repoPath: string, anchor: string | undefined): string {
	// Another chapter is in the same file now. Its heading ids can collide with other chapters'
	// (pandoc renames the repeats), so a cross-chapter link lands on the chapter title.
	const chapter = repoPath.match(/^docs\/book\/([^/]+\.md)$/)?.[1];
	if (chapter && chapters.includes(chapter)) return `#${chapterId(chapter)}`;
	// The guides describe the current release, so a reader gets the live page; source and
	// repo docs are pinned, so they show the code the book describes.
	const route = repoPath.startsWith("docs/") ? routeFor(repoPath.slice("docs/".length)) : null;
	const base = route ? `https://vereda.dev${route}` : `https://github.com/riosgabriel/vereda/blob/${pin}/${repoPath}`;
	return base + (anchor ? `#${anchor}` : "");
}

/** Rewrites the relative links in one chapter. Code like `fn(result)` stays: no file is called "result". */
function rewriteLinks(markdown: string, file: string): string {
	return markdown.replace(/\]\(([^)\s]+)\)/g, (whole, url: string) => {
		if (url.startsWith("#") || /^[a-z][a-z0-9+.-]*:/i.test(url)) return whole;
		const [path = "", anchor] = url.split("#", 2);
		const target = resolve(BOOK, dirname(file), path);
		if (!existsSync(target)) return whole;
		return `](${bookHref(relative(REPO_ROOT, target).split("\\").join("/"), anchor)})`;
	});
}

const work = mkdtempSync(join(tmpdir(), "vereda-book-"));
const browser = await chromium.launch();
try {
	const page = await browser.newPage();

	// Mermaid draws in a browser. SVG text labels (not HTML in a foreignObject) so EPUB readers show them.
	await page.setContent("<!doctype html><body></body>");
	await page.addScriptTag({ path: MERMAID });
	await page.evaluate(() => {
		// biome-ignore lint/suspicious/noExplicitAny: mermaid.min.js sets a global
		(window as any).mermaid.initialize({
			startOnLoad: false,
			theme: "neutral",
			htmlLabels: false,
			flowchart: { htmlLabels: false },
		});
	});
	let diagrams = 0;
	const renderDiagram = async (source: string) => {
		const name = `diagram-${++diagrams}.svg`;
		const svg = await page.evaluate(
			// biome-ignore lint/suspicious/noExplicitAny: mermaid.min.js sets a global
			async ([id, code]) => (await (window as any).mermaid.render(id, code)).svg as string,
			[`d${diagrams}`, source] as const,
		);
		writeFileSync(join(work, name), svg);
		return name;
	};

	const parts: string[] = [];
	for (const file of chapters) {
		let markdown = rewriteLinks(readFileSync(join(BOOK, file), "utf8"), file);
		markdown = markdown.replace(/^(# .+)$/m, `$1 {#${chapterId(file)}}`);
		for (const [fence, source = ""] of markdown.matchAll(/^```mermaid\n([\s\S]*?)^```$/gm)) {
			markdown = markdown.replace(fence, `![](${await renderDiagram(source)})`);
		}
		parts.push(markdown);
	}
	const source = join(work, "book.md");
	writeFileSync(source, parts.join("\n\n"));

	// The cover, in an e-reader's 2:3 for the EPUB and in A4's shape for the PDF's first page.
	const cover = await browser.newPage();
	for (const [name, height] of [
		["cover.png", 2400],
		["cover-a4.png", Math.round(1600 * Math.SQRT2)],
	] as const) {
		await cover.setViewportSize({ width: 1600, height });
		await cover.goto(`file://${COVER}#${pin.slice(0, 7)}`, { waitUntil: "networkidle" });
		await cover.evaluate(() => document.fonts.ready);
		await cover.screenshot({ path: join(work, name) });
	}
	const coverPage = join(work, "cover.html");
	writeFileSync(coverPage, '<img class="cover" src="cover-a4.png" alt="" />');

	mkdirSync(OUT, { recursive: true });
	const pandoc = (...args: string[]) =>
		execFileSync(
			"pandoc",
			[
				source,
				"--from=commonmark_x",
				`--resource-path=${work}`,
				"--toc",
				"--metadata=title:The Vereda Book",
				`--metadata=subtitle:How @vereda/http works inside, as of commit ${pin.slice(0, 7)}`,
				"--metadata=author:Gabriel Rios",
				"--metadata=lang:en",
				...args,
			],
			{ stdio: "inherit" },
		);

	pandoc(
		"--to=epub3",
		"--split-level=1",
		"--toc-depth=2",
		`--epub-cover-image=${join(work, "cover.png")}`,
		`--output=${join(OUT, "vereda-book.epub")}`,
	);

	// The PDF is the same book as one HTML page, printed by Chromium, the cover as its first page.
	// Its contents list only the chapters: on paper, every section would take five pages.
	const html = join(work, "book.html");
	pandoc(
		"--to=html5",
		"--standalone",
		"--toc-depth=1",
		"--embed-resources",
		`--css=${PRINT_CSS}`,
		`--include-before-body=${coverPage}`,
		`--output=${html}`,
	);
	await page.goto(`file://${html}`);
	await page.pdf({
		path: join(OUT, "vereda-book.pdf"),
		format: "A4",
		printBackground: true,
		// Margins come from book-print.css, so the cover's page can have none.
		preferCSSPageSize: true,
		displayHeaderFooter: true,
		headerTemplate: "<span></span>",
		footerTemplate: `<div style="font-size:8px;width:100%;text-align:center;color:#777"><span class="pageNumber"></span></div>`,
	});
	console.log(
		`Book at ${pin.slice(0, 7)}: ${chapters.length} chapters, ${diagrams} diagrams -> ${relative(process.cwd(), OUT)}`,
	);
} finally {
	await browser.close();
}
