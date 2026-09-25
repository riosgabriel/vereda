import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HttpClient } from "../../src/core/client.ts";
import { defaultHeaders, requestLogger } from "../../src/middleware/index.ts";

/**
 * Runs the README's "Middleware" example and checks the behavior its prose
 * claims (middleware can read and rewrite ctx.url).
 */

const README = readFileSync(new URL("../../README.md", import.meta.url), "utf8");
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (
	...args: string[]
) => (...params: unknown[]) => Promise<void>;

/** The first code block under README's "### Middleware", minus its import line. */
function readmeMiddlewareBody(): string {
	const section = README.slice(README.indexOf("### Middleware"));
	const block = section.match(/```typescript\n([\s\S]*?)```/)?.[1];
	if (!block) throw new Error("README has no typescript block under ### Middleware");
	const importLine = /^import \{([^}]*)\} from "vereda\/middleware";\n/m;
	const imported = block
		.match(importLine)?.[1]
		.split(",")
		.map((name) => name.trim());
	// The body runs as plain JavaScript with these names injected, so the
	// block must import exactly them and carry no TypeScript-only syntax.
	expect(imported, "README Middleware block must import exactly { defaultHeaders, requestLogger }").toEqual([
		"defaultHeaders",
		"requestLogger",
	]);
	return block.replace(importLine, "");
}

describe("README middleware example", () => {
	let server: Server;
	let url: string;
	let received: { headers: IncomingMessage["headers"]; url?: string };

	beforeAll(async () => {
		server = createServer((req, res) => {
			received = { headers: req.headers, url: req.url };
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end("{}");
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const addr = server.address();
		if (addr && typeof addr === "object") {
			url = `http://127.0.0.1:${addr.port}`;
		}
	});

	afterAll(async () => {
		await new Promise((resolve) => server.close(resolve));
	});

	it("runs the README's Middleware block verbatim against a real server", async () => {
		const client = HttpClient.create({ baseUrl: url, timeout: { attemptMs: 5_000 } });
		const logs: unknown[][] = [];
		const recordingConsole = { log: (...args: unknown[]) => logs.push(args) };

		// Execute the README block itself (not a copy), so editing the example
		// in the README is what this test checks. The snippet typecheck covers
		// its types; this covers what it does.
		const run = new AsyncFunction("client", "defaultHeaders", "requestLogger", "console", readmeMiddlewareBody());
		await run(client, defaultHeaders, requestLogger, recordingConsole);

		const result = await client.get("/resource").toPromise();

		expect(result.success).toBe(true);
		expect(received.headers.authorization).toBe("Bearer token123");
		expect(logs).toContainEqual(["Request:", `${url}/resource`, "attempt", 0]);
		expect(logs).toContainEqual(["Response:", 200]);

		await client.close();
	});

	it("lets middleware rewrite ctx.url before the request is sent", async () => {
		const client = HttpClient.create({ baseUrl: url, timeout: { attemptMs: 5_000 } });

		client.use(async (ctx, next) => {
			return next({ ...ctx, url: `${ctx.url}?rewritten=1` });
		});

		const result = await client.get("/original").toPromise();

		expect(result.success).toBe(true);
		expect(received.url).toBe("/original?rewritten=1");

		await client.close();
	});
});
