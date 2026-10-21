import { type CollectionEntry, getCollection } from "astro:content";
import type { APIRoute } from "astro";
import pkg from "../../../package.json";
import { SIDEBAR_ORDER } from "../doc-ids.ts";
import { PATTERNS } from "../patterns.ts";

// /llms.txt (https://llmstxt.org): a Markdown index of the site for coding agents. Built from the
// same collection and pattern list as the sidebar, so a new page shows up here without an edit.
type Doc = CollectionEntry<"docs">;
type Section = { title: string; links: { title: string; url: string }[] };

const SITE = "https://vereda.dev";
const byOrder = (a: Doc, b: Doc) => {
	const rank = (d: Doc) => SIDEBAR_ORDER.indexOf(d.id) + 1 || Infinity;
	return rank(a) - rank(b) || a.id.localeCompare(b.id);
};
const link = (d: Doc) => ({ title: d.data.title, url: `${SITE}/${d.id}/` });

export const GET: APIRoute = async () => {
	const docs = (await getCollection("docs")).sort(byOrder);
	const under = (prefix: string) => docs.filter((d) => d.id.startsWith(prefix));

	// Usage first, then reference. The Book (internals) and the simulators (interactive, prose
	// around them) go under "Optional", which llmstxt.org lets an agent skip when context is short.
	const sections: Section[] = [
		{ title: "Guide", links: under("guide/").map(link) },
		{ title: "Operations", links: under("operations").map(link) },
		{ title: "API reference", links: [{ title: "Every export and option", url: `${SITE}/api/readme/` }] },
		{
			title: "Optional",
			links: [
				...under("book").map(link),
				...PATTERNS.map((p) => ({ title: `Pattern: ${p.title}`, url: `${SITE}/patterns/${p.slug}/` })),
			],
		},
	];

	const body = [
		`# Vereda`,
		``,
		`> ${pkg.description}`,
		``,
		`Package \`${pkg.name}\` ${pkg.version}, ESM only, Node.js ${pkg.engines.node}. Install: \`npm install ${pkg.name}\`.`,
		`Requests return a ticket; \`await ticket.toPromise()\` never rejects and resolves to \`{ success, raw }\` or \`{ success: false, error }\` with a typed \`error.kind\`.`,
		...sections.flatMap((s) => [``, `## ${s.title}`, ``, ...s.links.map((l) => `- [${l.title}](${l.url})`)]),
		``,
	].join("\n");
	return new Response(body, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
};
