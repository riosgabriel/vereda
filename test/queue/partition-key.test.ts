import * as http from "node:http";
import { describe, expect, it } from "vitest";
import { HttpClient } from "../../src/core/client.js";
import type { BulkheadRegistry } from "../../src/queue/bulkhead.js";

function createServer(): Promise<{ url: string; close: () => Promise<void> }> {
	return new Promise((resolve) => {
		const server = http.createServer((_req, res) => {
			res.statusCode = 200;
			res.end("ok");
		});
		server.listen(0, "127.0.0.1", () => {
			const addr = server.address()!;
			const port = typeof addr === "string" ? 0 : addr.port;
			resolve({
				url: `http://127.0.0.1:${port}`,
				close: () => new Promise<void>((r) => server.close(() => r())),
			});
		});
	});
}

describe("Origin partition key (5.3)", () => {
	it("different host:port values land in different partitions", async () => {
		const server1 = await createServer();
		const server2 = await createServer();

		try {
			const client = HttpClient.create({ retry: { maxRetries: 0 } });

			await client.get(server1.url).toPromise();
			await client.get(server2.url).toPromise();

			// Access internal bulkhead registry to verify partition count.
			// client._bulkheads is private but accessible via "as any" in tests.
			const registry = (client as unknown as { bulkheads: BulkheadRegistry }).bulkheads;
			const snapshots = registry.getAll();
			expect(snapshots.length).toBe(2);
			const names = snapshots.map((s) => s.name).sort();
			expect(names[0]).not.toBe(names[1]);

			await client.close();
		} finally {
			await server1.close();
			await server2.close();
		}
	});

	it("same host:port lands in same partition", async () => {
		const server = await createServer();

		try {
			const client = HttpClient.create({ retry: { maxRetries: 0 } });

			await client.get(`${server.url}/a`).toPromise();
			await client.get(`${server.url}/b`).toPromise();

			const registry = (client as unknown as { bulkheads: BulkheadRegistry }).bulkheads;
			const snapshots = registry.getAll();
			expect(snapshots).toHaveLength(1);

			await client.close();
		} finally {
			await server.close();
		}
	});

	it("explicit partition overrides the default", async () => {
		const server = await createServer();

		try {
			const client = HttpClient.create({ retry: { maxRetries: 0 } });

			await client.get(server.url, { partition: "custom" }).toPromise();

			const registry = (client as unknown as { bulkheads: BulkheadRegistry }).bulkheads;
			const snapshots = registry.getAll();
			expect(snapshots).toHaveLength(1);
			expect(snapshots[0].name).toBe("custom");

			await client.close();
		} finally {
			await server.close();
		}
	});
});
