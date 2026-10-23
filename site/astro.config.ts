import { unified } from "@astrojs/markdown-remark";
import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";
import starlightTypeDoc, { typeDocSidebarGroup } from "starlight-typedoc";
import { PATTERNS } from "./src/patterns.ts";
import { remarkCallouts } from "./src/remark/callouts.ts";
import { remarkDocLinks } from "./src/remark/doc-links.ts";
import { remarkDropTitle } from "./src/remark/drop-title.ts";
import { remarkMermaid } from "./src/remark/mermaid.ts";

// The public entry points, as in package.json "exports".
const ENTRY_POINTS = [
	"src/core/index.ts",
	"src/middleware/index.ts",
	"src/adapters/zod.ts",
	"src/otel/index.ts",
	"src/testing/index.ts",
];

// The site reads the hand-written docs straight from ../docs (see src/content.config.ts),
// so docs/book stays where book:check and book:drift expect it.
export default defineConfig({
	site: "https://vereda.dev",
	trailingSlash: "always",
	// starlight-typedoc puts the API overview at /api/readme/; keep the short URL working.
	redirects: { "/api/": "/api/readme/" },
	markdown: {
		processor: unified({ remarkPlugins: [remarkDropTitle, remarkDocLinks, remarkMermaid, remarkCallouts] }),
	},
	integrations: [
		starlight({
			title: "Vereda",
			description:
				"Retries, backoff, timeouts, per-host isolation and circuit breaking for fetch on Node.js, Bun and Cloudflare Workers.",
			social: [{ icon: "github", label: "GitHub", href: "https://github.com/riosgabriel/vereda" }],
			editLink: { baseUrl: "https://github.com/riosgabriel/vereda/edit/main/docs/" },
			components: {
				Head: "./src/components/Head.astro",
				Header: "./src/components/Header.astro",
				MobileMenuFooter: "./src/components/MobileMenuFooter.astro",
				ThemeSelect: "./src/components/ThemeSelect.astro",
				SiteTitle: "./src/components/SiteTitle.astro",
				Footer: "./src/components/Footer.astro",
				PageTitle: "./src/components/PageTitle.astro",
				Search: "./src/components/Search.astro",
			},
			customCss: ["./src/styles/theme.css"],
			// Starlight's Markdown transforms (heading anchor links, code block defaults) only run on
			// its own content folder unless listed here, and the docs load from the repo's docs/.
			// Rendered Markdown is cached in .astro/data-store.json: clear it after changing these.
			markdown: { processedDirs: ["../docs"] },
			// Long code lines wrap, keeping their indent, instead of scrolling sideways. The book
			// quotes source as written, so its excerpts keep their real line lengths.
			expressiveCode: { defaultProps: { wrap: true } },
			logo: { src: "./src/assets/logo.png" },
			favicon: "/favicon.png",
			head: [
				{ tag: "link", attrs: { rel: "apple-touch-icon", href: "/apple-touch-icon.png" } },
				// Social preview for every page; regenerate it from scripts/og-image.html.
				{ tag: "meta", attrs: { property: "og:image", content: "https://vereda.dev/og.png" } },
				{ tag: "meta", attrs: { property: "og:image:width", content: "1200" } },
				{ tag: "meta", attrs: { property: "og:image:height", content: "630" } },
				{
					tag: "meta",
					attrs: { property: "og:image:alt", content: "Vereda: Make fetch resilient. npm install @vereda/http" },
				},
				{ tag: "meta", attrs: { name: "twitter:image", content: "https://vereda.dev/og.png" } },
				// Cloudflare Web Analytics: cookieless page views. The token is public (it ships in the HTML);
				// the dashboard is under Analytics & Logs > Web Analytics in the Cloudflare account.
				{
					tag: "script",
					attrs: {
						type: "module",
						src: "https://static.cloudflareinsights.com/beacon.min.js",
						"data-cf-beacon": '{"token": "801fab46bf6e42e49bec265071570bc4"}',
					},
				},
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
