import { unified } from "@astrojs/markdown-remark";
import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";
import starlightTypeDoc, { typeDocSidebarGroup } from "starlight-typedoc";
import { demos } from "./src/integrations/demos.ts";
import { PATTERNS } from "./src/patterns.ts";
import { remarkDocLinks } from "./src/remark/doc-links.ts";
import { remarkDropTitle } from "./src/remark/drop-title.ts";
import { remarkMermaid } from "./src/remark/mermaid.ts";

// The public entry points, as in package.json "exports".
const ENTRY_POINTS = ["src/core/index.ts", "src/middleware/index.ts", "src/adapters/zod.ts", "src/otel/index.ts"];

// The site reads the hand-written docs straight from ../docs (see src/content.config.ts),
// so docs/book stays where book:check and book:drift expect it.
export default defineConfig({
	site: "https://vereda.dev",
	trailingSlash: "always",
	// starlight-typedoc puts the API overview at /api/readme/; keep the short URL working.
	// /patterns/<name>/ is the clean URL for each demo (and what Starlight's sidebar links to, since it
	// adds a trailing slash); the demo itself is a plain file at /patterns/<name>.html.
	redirects: {
		"/api/": "/api/readme/",
		...Object.fromEntries(PATTERNS.map((p) => [`/patterns/${p.file.replace(/\.html$/, "")}/`, `/patterns/${p.file}`])),
	},
	markdown: {
		processor: unified({ remarkPlugins: [remarkDropTitle, remarkDocLinks, remarkMermaid] }),
	},
	integrations: [
		demos(),
		starlight({
			title: "Vereda",
			description: "Resilient HTTP for TypeScript: retries, timeouts, bulkheads, circuit breakers.",
			social: [{ icon: "github", label: "GitHub", href: "https://github.com/riosgabriel/vereda" }],
			editLink: { baseUrl: "https://github.com/riosgabriel/vereda/edit/main/docs/" },
			components: { Head: "./src/components/Head.astro" },
			customCss: ["./src/styles/theme.css"],
			head: [
				{ tag: "link", attrs: { rel: "preconnect", href: "https://fonts.googleapis.com" } },
				{ tag: "link", attrs: { rel: "preconnect", href: "https://fonts.gstatic.com", crossorigin: true } },
				{
					tag: "link",
					attrs: {
						rel: "stylesheet",
						href: "https://fonts.googleapis.com/css2?family=Schibsted+Grotesk:wght@600;800&family=Source+Sans+3:wght@400;600&family=JetBrains+Mono:wght@400;600&display=swap",
					},
				},
			],
			plugins: [
				starlightTypeDoc({
					entryPoints: ENTRY_POINTS.map((p) => `../${p}`),
					tsconfig: "../tsconfig.json",
					sidebar: { label: "API reference", collapsed: true },
					typeDoc: {
						// Without a readme, the plugin skips the per-module overview pages but still links to them.
						readme: "./src/api-overview.md",
						excludeInternal: true,
						excludePrivate: true,
						excludeProtected: true,
						sort: ["source-order"],
					},
				}),
			],
			sidebar: [
				{ label: "Guide", items: [{ autogenerate: { directory: "guide" } }] },
				{ label: "Operations", link: "/operations/" },
				{
					label: "Patterns, animated",
					items: [
						{ label: "Overview", link: "/patterns/" },
						...PATTERNS.map((p) => ({ label: p.title, link: `/patterns/${p.file.replace(/\.html$/, "")}/` })),
					],
				},
				{ label: "The Vereda Book", items: [{ autogenerate: { directory: "book" } }] },
				typeDocSidebarGroup,
			],
		}),
	],
});
