import { defineCollection } from "astro:content";
import { readFile } from "node:fs/promises";
import { docsSchema } from "@astrojs/starlight/schema";
import { glob, type Loader } from "astro/loaders";
import { DOC_PATTERNS, idFor } from "./doc-ids.ts";

// One glob over the repo root covers both sources. Two loaders can't share a collection: each
// glob deletes the entries it didn't load itself.
const REPO = "..";
const API = "site/src/content/docs/api"; // written by starlight-typedoc (astro.config.ts)

const FIRST_H1 = /^#\s+(.+)$/m;

/**
 * Starlight requires a `title` in front-matter, and the docs have none: each file opens with
 * its H1. This wraps the glob loader and fills `title` from that H1 before the schema runs,
 * so the Markdown files stay plain. remarkDropTitle then removes the H1 from the body, since
 * Starlight prints the title itself.
 */
function docsFromRepo(): Loader {
	const inner = glob({
		base: REPO,
		pattern: [...DOC_PATTERNS.map((p) => `docs/${p}`), `${API}/**/*.md`],
		// API pages keep Starlight's plain path ids (README included), which is what
		// starlight-typedoc links to.
		generateId: ({ entry }) =>
			entry.startsWith(`${API}/`)
				? entry
						.slice(API.length - "api".length)
						.replace(/\.md$/, "")
						.toLowerCase()
				: idFor(entry.slice("docs/".length)),
	});
	return {
		name: "vereda-docs",
		load: (context) =>
			inner.load({
				...context,
				parseData: async (props) => {
					if (typeof props.data.title !== "string" && props.filePath) {
						const body = await readFile(props.filePath, "utf-8");
						const h1 = FIRST_H1.exec(body)?.[1]?.trim();
						if (h1) props.data = { ...props.data, title: h1 };
					}
					return context.parseData(props);
				},
			}),
	};
}

export const collections = {
	docs: defineCollection({ loader: docsFromRepo(), schema: docsSchema() }),
};
