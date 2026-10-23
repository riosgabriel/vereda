// Builds the Vereda Book as one EPUB and one PDF into public/downloads/, which the sidebar links
// to. Needs pandoc on PATH and Playwright's Chromium (`bunx playwright install chromium`), which
// renders the Mermaid diagrams to SVG and prints the PDF. Run before `astro build`:
// `bun scripts/book-download.ts`.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { routeFor } from "../src/doc-ids.ts";
import { CALLOUTS, capitalize, SECTIONS } from "../src/remark/callouts.ts";

const REPO_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const BOOK = join(REPO_ROOT, "docs/book");
const OUT = fileURLToPath(new URL("../public/downloads/", import.meta.url));
const MERMAID = fileURLToPath(new URL("../node_modules/mermaid/dist/mermaid.min.js", import.meta.url));
const PRINT_CSS = fileURLToPath(new URL("./book-print.css", import.meta.url));
const CALLOUTS_CSS = fileURLToPath(new URL("./book-callouts.css", import.meta.url));
const COVER = fileURLToPath(new URL("./book-cover.html", import.meta.url));
// The site's type. Chromium loads it for the PDF; pandoc would try to embed it and time out.
const FONTS =
	"https://fonts.googleapis.com/css2?family=Schibsted+Grotesk:ital,wght@0,400..800;1,400..800&family=JetBrains+Mono:ital,wght@0,400..700;1,400..700&display=block";

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

/**
 * Marks the callouts and recurring sections the way the site does (src/remark/callouts.ts), as
 * pandoc attributes: a blockquote is wrapped in a classed div, a heading gets classes, which
 * `--section-divs` moves onto its section. Labels become `.callout-label` spans.
 */
function markCallouts(markdown: string): string {
	const label = (text: string) => `[${text}[: ]{.callout-sep}]{.callout-label}`;
	return markdown
		.replace(/^(?:>.*(?:\n|$))+/gm, (quote) => {
			const opening = quote.match(/^> \*\*(.+?)\*\*/)?.[1] ?? "";
			const callout = CALLOUTS.find((c) => c.match.test(opening));
			if (!callout) return quote;
			const title = capitalize(opening.replace(callout.match, ""));
			const body = quote.replace(/^> \*\*.+?\*\*/, `> ${label(callout.label)}${title ? ` **${title}**` : ""}`);
			return `::: {.callout .callout--${callout.kind}}\n${body.endsWith("\n") ? body : `${body}\n`}:::\n`;
		})
		.replace(/^## (.+)$/gm, (heading, text: string) => {
			const section = SECTIONS.find((s) => s.match.test(text));
			if (!section) return heading;
			const title = section.label ? `${label(section.label)} ${capitalize(text.replace(section.match, ""))}` : text;
			return `## ${title} {.book-section .book-section--${section.kind}}`;
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
	/** Draws one diagram to an SVG file and returns it as a Markdown image, with its alt text. */
	const renderDiagram = async (source: string) => {
		const name = `diagram-${++diagrams}.svg`;
		const { svg, alt } = await page.evaluate(
			async ([id, code]) => {
				// biome-ignore lint/suspicious/noExplicitAny: mermaid.min.js sets a global
				const mermaid = (window as any).mermaid;
				const { svg } = await mermaid.render(id, code);
				// The diagram as text, from Mermaid's own parse of it, for screen readers and for
				// anything that reads the PDF's text (which otherwise gets the labels as loose words).
				const text = (label = "") =>
					label
						.replace(/<br\s*\/?>/g, " ")
						.replace(/<[^>]+>/g, "")
						.trim();
				const step = (from: string, to: string, label = "") =>
					`${from} → ${to}${text(label) ? ` (${text(label)})` : ""}`;
				const diagram = await mermaid.mermaidAPI.getDiagramFromText(code);
				let steps: string[];
				let kind: string;
				if (diagram.type === "sequence") {
					kind = "Sequence diagram";
					const actors = diagram.db.getActors() as Map<string, { description: string }>;
					const who = (name: string) => text(actors.get(name)?.description ?? name);
					steps = (diagram.db.getMessages() as { from?: string; to?: string; message: string }[])
						.filter((m) => m.from && m.to)
						.map((m) => `${step(who(m.from ?? ""), who(m.to ?? ""))}: ${text(m.message)}`);
				} else {
					kind = diagram.type.startsWith("state") ? "State diagram" : "Flowchart";
					const { nodes, edges } = diagram.db.getData() as {
						nodes: { id: string; label?: string }[];
						edges: { start: string; end: string; label?: string }[];
					};
					const labels = new Map(nodes.map((n) => [n.id, text(n.label) || n.id]));
					const node = (id: string) =>
						/_start$/.test(id) ? "start" : /_end$/.test(id) ? "end" : (labels.get(id) ?? id);
					steps = edges.map((e) => step(node(e.start), node(e.end), e.label));
				}
				return { svg: svg as string, alt: `${kind}: ${steps.join("; ")}.` };
			},
			[`d${diagrams}`, source] as const,
		);
		writeFileSync(join(work, name), svg);
		// An alt attribute, not ![alt](…): pandoc would print that as a caption. It can't hold a ".
		return `![](${name}){alt="${alt.replaceAll('"', "'")}"}`;
	};

	const parts: string[] = [];
	for (const file of chapters) {
		let markdown = markCallouts(rewriteLinks(readFileSync(join(BOOK, file), "utf8"), file));
		// The cover is the title page, so the README's "# The Vereda Book" opens the book as what it is.
		if (file === "README.md") markdown = markdown.replace(/^# .+$/m, "# About this book");
		markdown = markdown.replace(/^(# .+)$/m, `$1 {#${chapterId(file)}}`);
		for (const [fence, source = ""] of markdown.matchAll(/^```mermaid\n([\s\S]*?)^```$/gm)) {
			markdown = markdown.replace(fence, await renderDiagram(source));
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

	// pandoc's own EPUB stylesheet gives way to one passed with --css, so the callouts go after it.
	const epubCss = join(work, "epub.css");
	writeFileSync(
		epubCss,
		execFileSync("pandoc", ["--print-default-data-file=epub.css"], { encoding: "utf8" }) +
			readFileSync(CALLOUTS_CSS, "utf8"),
	);
	pandoc(
		"--to=epub3",
		"--section-divs",
		`--css=${epubCss}`,
		"--split-level=1",
		"--toc-depth=2",
		"--epub-title-page=false",
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
		"--section-divs",
		"--embed-resources",
		`--css=${PRINT_CSS}`,
		`--css=${CALLOUTS_CSS}`,
		`--include-before-body=${coverPage}`,
		`--output=${html}`,
	);
	await page.goto(`file://${html}`);
	await page.addStyleTag({ url: FONTS });
	// If Google Fonts didn't answer, Chromium would print in a fallback sans without a word.
	// (document.fonts.check() won't do: with no @font-face for a family at all, it returns true.)
	const loaded = await page.evaluate(async () => {
		await document.fonts.ready;
		const faces = [...document.fonts].filter((f) => f.status === "loaded").map((f) => f.family.replaceAll('"', ""));
		return faces.includes("Schibsted Grotesk") && faces.includes("JetBrains Mono");
	});
	if (!loaded) throw new Error(`The book's fonts didn't load from ${FONTS}`);
	await page.pdf({
		path: join(OUT, "vereda-book.pdf"),
		format: "A4",
		printBackground: true,
		// Margins come from book-print.css, so the cover's page can have none.
		preferCSSPageSize: true,
		// Tagged for screen readers and text extraction; the outline is the PDF viewer's contents
		// sidebar, so a reader can jump between chapters from any page.
		tagged: true,
		outline: true,
		displayHeaderFooter: true,
		headerTemplate: "<span></span>",
		footerTemplate: `<div style="font-size:8px;width:100%;text-align:center;color:#777"><span class="pageNumber"></span></div>`,
	});
	console.log(
		`Book at ${pin.slice(0, 7)}: ${chapters.length} chapters, ${diagrams} diagrams -> ${relative(process.cwd(), OUT)}`,
	);
} finally {
	await browser.close();
	rmSync(work, { recursive: true, force: true });
}
