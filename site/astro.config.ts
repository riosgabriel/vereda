import { unified } from "@astrojs/markdown-remark";
import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";
import starlightTypeDoc, { typeDocSidebarGroup } from "starlight-typedoc";
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
	redirects: { "/api/": "/api/readme/" },
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
			customCss: ["./src/styles/theme.css"],
			logo: { src: "./src/assets/logo.png" },
			favicon: "/favicon.png",
			head: [
				{ tag: "link", attrs: { rel: "apple-touch-icon", href: "/apple-touch-icon.png" } },
				{ tag: "link", attrs: { rel: "preconnect", href: "https://fonts.googleapis.com" } },
				{ tag: "link", attrs: { rel: "preconnect", href: "https://fonts.gstatic.com", crossorigin: true } },
				{
					tag: "link",
					attrs: {
						rel: "stylesheet",
						href: "https://fonts.googleapis.com/css2?family=Schibsted+Grotesk:ital,wght@0,400;0,600;0,800;1,400&family=JetBrains+Mono:wght@400;600&display=swap",
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
				// autogenerate matches each entry's filePath, and these load from the repo's docs/
				// (src/content.config.ts), so the directories are ../docs/guide and ../docs/book.
				{ label: "Guide", items: [{ autogenerate: { directory: "../docs/guide" } }] },
				{ label: "Operations", link: "/operations/" },
				{
					label: "Patterns, animated",
					items: [
						{ label: "Overview", link: "/patterns/" },
						...PATTERNS.map((p) => ({ label: p.title, link: `/patterns/${p.slug}/` })),
					],
				},
				{ label: "The Vereda Book", items: [{ autogenerate: { directory: "../docs/book" } }] },
				typeDocSidebarGroup,
			],
		}),
	],
});
