// node scripts/smoke/workers.mjs   (needs `npm run build` and `miniflare`;
// CI installs it with `npm install --no-save`, so it isn't a devDependency)
// Runs runtime.mjs inside workerd with no compatibility flags, so in
// particular without `nodejs_compat`: a `node:` import fails to load.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { Miniflare } from "miniflare";

const root = resolve(import.meta.dirname, "../..");
const dist = readdirSync(join(root, "dist"), { recursive: true, encoding: "utf8" })
	.filter((f) => f.endsWith(".js"))
	.map((f) => join(root, "dist", f));

// workerd resolves a bare specifier relative to the importing module's
// directory, with no node_modules lookup. So each module that imports
// "@opentelemetry/api" gets a sibling module of that name re-exporting the
// package's ESM build, which is registered alongside. That build imports its
// own files without the ".js" extension, so they're registered under those
// extensionless names.
const otelApi = join(root, "node_modules/@opentelemetry/api/build/esm");
const otelApiFiles = readdirSync(otelApi, { recursive: true, encoding: "utf8" })
	.filter((f) => f.endsWith(".js"))
	.map((f) => join(otelApi, f));

const entry = `import { smoke } from "./scripts/smoke/runtime.mjs";
export default {
	async fetch() {
		try {
			await smoke();
			return new Response("ok");
		} catch (err) {
			return new Response(String(err?.stack ?? err), { status: 500 });
		}
	},
};`;

const mf = new Miniflare({
	modulesRoot: root,
	modules: [
		{ type: "ESModule", path: join(root, "entry.mjs"), contents: entry },
		{ type: "ESModule", path: join(root, "scripts/smoke/runtime.mjs") },
		...dist.map((path) => ({ type: "ESModule", path })),
		...["dist/otel", "scripts/smoke"].map((importer) => ({
			type: "ESModule",
			path: join(root, importer, "@opentelemetry/api"),
			contents: `export * from "${relative(join(root, importer, "@opentelemetry"), join(otelApi, "index"))}";`,
		})),
		...otelApiFiles.map((path) => ({
			type: "ESModule",
			path: path.slice(0, -".js".length),
			contents: readFileSync(path, "utf8"),
		})),
	],
	compatibilityDate: "2026-01-01",
});

try {
	const res = await mf.dispatchFetch("http://smoke.test/");
	const body = await res.text();
	if (!res.ok) throw new Error(`workers smoke failed:\n${body}`);
	console.log(`workers smoke: ok (${dist.length} modules from ${relative(root, join(root, "dist"))}/)`);
} finally {
	await mf.dispose();
}
