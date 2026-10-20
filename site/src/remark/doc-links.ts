import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Link, Root } from "mdast";
import type { VFile } from "vfile";
import { routeFor } from "../doc-ids.ts";

const REPO_ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const GITHUB_BLOB = "https://github.com/riosgabriel/vereda/blob/main/";

/**
 * Where a link to `repoPath` (relative to the repo root, no anchor) should point: its site
 * route if the site serves it (see doc-ids.ts), otherwise the file on GitHub.
 */
export function hrefFor(repoPath: string): string {
	const route = repoPath.startsWith("docs/") ? routeFor(repoPath.slice("docs/".length)) : null;
	return route ?? GITHUB_BLOB + repoPath;
}

/** Rewrites relative links in the docs (`../guide/requests.md#x`) into site routes or GitHub URLs. */
export function remarkDocLinks() {
	return (tree: Root, file: VFile) => {
		if (!file.path) return;
		const from = dirname(file.path);
		const visit = (node: Root | Root["children"][number]) => {
			if (node.type === "link") rewrite(node, from);
			if ("children" in node) for (const child of node.children) visit(child);
		};
		visit(tree);
	};
}

const SITE = "https://vereda.dev/";

function rewrite(link: Link, from: string) {
	const url = link.url;
	// Absolute links to the site (they also work on GitHub) stay on whichever host serves the page.
	if (url?.startsWith(SITE)) {
		link.url = `/${url.slice(SITE.length)}`;
		return;
	}
	if (!url || url.startsWith("#") || /^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith("/")) return;
	const [path, anchor] = url.split("#", 2);
	const repoPath = relative(REPO_ROOT, resolve(from, path)).split("\\").join("/");
	if (repoPath.startsWith("..")) return; // outside the repo; leave it alone
	link.url = hrefFor(repoPath) + (anchor ? `#${anchor}` : "");
}
