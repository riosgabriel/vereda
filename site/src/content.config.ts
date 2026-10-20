import { defineCollection } from "astro:content";
import { readFile } from "node:fs/promises";
import { docsSchema } from "@astrojs/starlight/schema";
import { glob, type Loader } from "astro/loaders";
import { DOC_PATTERNS, idFor } from "./doc-ids.ts";

const DOCS = "../docs";

const FIRST_H1 = /^#\s+(.+)$/m;

/**
 * Starlight requires a `title` in front-matter, and the docs have none: each file opens with
 * its H1. This wraps the glob loader and fills `title` from that H1 before the schema runs,
 * so the Markdown files stay plain. remarkDropTitle then removes the H1 from the body, since
 * Starlight prints the title itself.
 */
function docsFromRepo(): Loader {
	const inner = glob({
		base: DOCS,
		pattern: DOC_PATTERNS,
		generateId: ({ entry }) => idFor(entry),
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
