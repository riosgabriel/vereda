// node scripts/smoke/workers.mjs   (needs `npm run build` and `miniflare`;
// CI installs it with `npm install --no-save`, so it isn't a devDependency)
// Runs runtime.mjs inside workerd with no compatibility flags, so in
// particular without `nodejs_compat`: a `node:` import fails to load.
import { readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { Miniflare } from "miniflare";

const root = resolve(import.meta.dirname, "../..");
const dist = readdirSync(join(root, "dist"), { recursive: true, encoding: "utf8" })
	.filter((f) => f.endsWith(".js"))
	.map((f) => join(root, "dist", f));

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
