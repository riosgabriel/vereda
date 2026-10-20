import { unified } from "@astrojs/markdown-remark";
import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";
import { remarkDocLinks } from "./src/remark/doc-links.ts";
import { remarkDropTitle } from "./src/remark/drop-title.ts";
import { remarkMermaid } from "./src/remark/mermaid.ts";

// The site reads the hand-written docs straight from ../docs (see src/content.config.ts),
// so docs/book stays where book:check and book:drift expect it.
export default defineConfig({
	site: "https://vereda.dev",
	trailingSlash: "always",
	markdown: {
		processor: unified({ remarkPlugins: [remarkDropTitle, remarkDocLinks, remarkMermaid] }),
	},
	integrations: [
		starlight({
			title: "Vereda",
			description: "Resilient HTTP for TypeScript: retries, timeouts, bulkheads, circuit breakers.",
			social: [{ icon: "github", label: "GitHub", href: "https://github.com/riosgabriel/vereda" }],
			editLink: { baseUrl: "https://github.com/riosgabriel/vereda/edit/main/docs/" },
			components: { Head: "./src/components/Head.astro" },
			sidebar: [
				{ label: "Guide", items: [{ autogenerate: { directory: "guide" } }] },
				{ label: "Operations", link: "/operations/" },
				{ label: "The Vereda Book", items: [{ autogenerate: { directory: "book" } }] },
				{ label: "API reference", link: "/api/", attrs: { target: "_self" } },
			],
		}),
	],
});
