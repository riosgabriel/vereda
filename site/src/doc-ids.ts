/** The files under docs/ that the site serves, relative to docs/. */
export const DOC_PATTERNS = ["book/*.md", "guide/*.md", "operations.md"];

const SERVED = /^(book|guide)\/[^/]+\.md$|^operations\.md$/;

/** `book/README.md` → `book`, `guide/requests.md` → `guide/requests`. Starlight routes by id. */
export function idFor(entry: string): string {
	const id = entry.replace(/\.md$/, "").toLowerCase();
	return id === "readme" ? "index" : id.replace(/\/readme$/, "");
}

/** The site route for a path relative to docs/, or null if the site doesn't serve it. */
export function routeFor(docsPath: string): string | null {
	if (!SERVED.test(docsPath)) return null;
	const id = idFor(docsPath);
	return id === "index" ? "/" : `/${id}/`;
}
