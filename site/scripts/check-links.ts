// Checks every internal link in the built site (dist/): the target file exists and, for
// `page/#anchor`, the page has an element with that id. External links are not fetched.
// Run after `astro build`: `bun scripts/check-links.ts`. Exits 1 and lists each broken link.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, posix, relative } from "node:path";

const DIST = new URL("../dist/", import.meta.url).pathname;

function* htmlFiles(dir: string): Generator<string> {
	for (const name of readdirSync(dir)) {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) yield* htmlFiles(path);
		else if (name.endsWith(".html")) yield path;
	}
}

/** The file a site path is served from: the file itself, or the folder's index.html. */
function fileFor(sitePath: string): string | null {
	const path = join(DIST, decodeURIComponent(sitePath));
	if (existsSync(path) && statSync(path).isFile()) return path;
	const index = join(path, "index.html");
	return existsSync(index) ? index : null;
}

const idCache = new Map<string, Set<string>>();
function idsIn(file: string): Set<string> {
	let ids = idCache.get(file);
	if (!ids) {
		ids = new Set([...readFileSync(file, "utf8").matchAll(/\sid="([^"]+)"/g)].map((m) => m[1] ?? ""));
		idCache.set(file, ids);
	}
	return ids;
}

const broken: string[] = [];
let checked = 0;
for (const file of htmlFiles(DIST)) {
	const page = `/${relative(DIST, file).split("\\").join("/")}`;
	const html = readFileSync(file, "utf8");
	for (const [, attr, raw] of html.matchAll(/\s(href|src)="([^"]*)"/g)) {
		const url = (raw ?? "").replaceAll("&amp;", "&");
		// Skip external and non-navigational URLs: https:, mailto:, data:, //host, and so on.
		if (!url || /^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith("//")) continue;
		checked++;
		const [pathAndQuery = "", anchor] = url.split("#", 2);
		const path = pathAndQuery.split("?", 1)[0] ?? "";
		// posix.resolve drops a trailing slash, and `file.pdf/` 404s where `file.pdf` doesn't.
		const resolved = path ? posix.resolve(posix.dirname(page), path) + (path.endsWith("/") ? "/" : "") : "";
		const target = path ? fileFor(resolved) : file;
		if (!target) broken.push(`${page}: ${attr}="${url}" (no such page or file)`);
		else if (anchor && target.endsWith(".html") && !idsIn(target).has(decodeURIComponent(anchor)))
			broken.push(`${page}: ${attr}="${url}" (no #${anchor} on that page)`);
	}
}

if (broken.length) {
	console.error(broken.join("\n"));
	console.error(`\n${broken.length} broken of ${checked} internal links.`);
	process.exit(1);
}
console.log(`${checked} internal links, all resolve.`);
