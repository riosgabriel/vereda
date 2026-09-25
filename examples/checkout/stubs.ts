import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

// ---------------------------------------------------------------------------
// Stub upstream servers for the checkout example
// ---------------------------------------------------------------------------
//
// Three tiny `node:http` servers, each bound to its own ephemeral port on
// 127.0.0.1 — no network, nothing to install. Vereda partitions by
// `new URL(url).host` (hostname:port), so three ports means three
// partitions: a failing payments dependency can't affect inventory or
// shipping traffic even though all three live in the same process.

export interface Stub {
	/** Base URL of the stub, e.g. "http://127.0.0.1:54321". */
	url: string;
	/** `host` as Vereda's default partitioning sees it (hostname:port). */
	host: string;
	/** Number of requests the stub has received so far. */
	hits: () => number;
	close: () => Promise<void>;
}

function startStub(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<Stub> {
	return new Promise((resolve) => {
		let hitCount = 0;
		const server = createServer((req, res) => {
			hitCount++;
			handler(req, res);
		});
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (address === null || typeof address === "string") {
				throw new Error("stub server did not bind to a TCP port");
			}
			resolve({
				url: `http://127.0.0.1:${address.port}`,
				host: `127.0.0.1:${address.port}`,
				hits: () => hitCount,
				close: () =>
					new Promise((r) => {
						// Force-close any lingering keep-alive sockets so the process
						// can exit immediately instead of waiting out the client's
						// idle timeout.
						server.closeAllConnections();
						server.close(() => r());
					}),
			});
		});
	});
}

/** Always answers 503 — the one dependency the demo drives into the ground. */
export function startPaymentsStub(): Promise<Stub> {
	return startStub((_req, res) => {
		res.writeHead(503, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ error: "payments temporarily unavailable" }));
	});
}

/** Always answers 200 — healthy, unaffected by payments' outage. */
export function startInventoryStub(): Promise<Stub> {
	return startStub((_req, res) => {
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ inStock: true }));
	});
}

/** Always answers 200 — healthy, unaffected by payments' outage. */
export function startShippingStub(): Promise<Stub> {
	return startStub((_req, res) => {
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ etaDays: 3 }));
	});
}
