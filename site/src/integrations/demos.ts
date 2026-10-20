import { createReadStream, existsSync, statSync } from "node:fs";
import { cp } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import type { AstroIntegration } from "astro";

const DEMOS = fileURLToPath(new URL("../../demos/", import.meta.url));
const PREFIX = "/patterns/";
const TYPES: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
};

/**
 * Serves site/demos/ at /patterns/ as plain files: the dev server streams them, and the build
 * copies them into dist/. They stay out of public/ and out of Vite's bundling because
 * test/demos/*.parity.test.ts imports site/demos/models/*.js by path.
 */
export function demos(): AstroIntegration {
	return {
		name: "vereda-demos",
		hooks: {
			"astro:config:setup": ({ updateConfig }) => {
				updateConfig({
					vite: {
						plugins: [
							{
								name: "vereda-demos-dev",
								configureServer(server) {
									server.middlewares.use((req, res, next) => {
										const url = req.url?.split("?")[0] ?? "";
										if (!url.startsWith(PREFIX)) return next();
										const file = normalize(join(DEMOS, url.slice(PREFIX.length)));
										if (!file.startsWith(DEMOS) || !existsSync(file) || !statSync(file).isFile()) return next();
										res.setHeader("Content-Type", TYPES[extname(file)] ?? "application/octet-stream");
										createReadStream(file).pipe(res);
									});
								},
							},
						],
					},
				});
			},
			"astro:build:done": async ({ dir }) => {
				await cp(DEMOS, fileURLToPath(new URL(PREFIX.slice(1), dir)), { recursive: true });
			},
		},
	};
}
