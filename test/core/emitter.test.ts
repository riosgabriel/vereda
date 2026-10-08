import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { Emitter } from "../../src/core/listeners.ts";

describe("Emitter", () => {
	it("runs a listener once per registration", () => {
		const emitter = new Emitter();
		const fn = vi.fn();
		emitter.on("x", fn);
		emitter.on("x", fn);
		emitter.emit("x", 1);

		expect(fn).toHaveBeenCalledTimes(2);
		expect(fn).toHaveBeenCalledWith(1);
	});

	it("off removes one registration, the most recent", () => {
		const emitter = new Emitter();
		const calls: string[] = [];
		const a = () => calls.push("a");
		const b = () => calls.push("b");
		emitter.on("x", a);
		emitter.on("x", b);
		emitter.on("x", a);
		emitter.off("x", a);
		emitter.emit("x");

		expect(calls).toEqual(["a", "b"]);
	});

	it("emits over a snapshot: changes mid-emit apply to the next emit", () => {
		const emitter = new Emitter();
		const late = vi.fn();
		const second = vi.fn();
		emitter.on("x", () => {
			emitter.on("x", late);
			emitter.off("x", second);
		});
		emitter.on("x", second);

		emitter.emit("x");
		expect(late).not.toHaveBeenCalled();
		expect(second).toHaveBeenCalledTimes(1);

		emitter.emit("x");
		expect(late).toHaveBeenCalledTimes(1);
		expect(second).toHaveBeenCalledTimes(1);
	});

	it("keeps running listeners after one throws, and rethrows on a microtask", async () => {
		const emitter = new Emitter();
		const after = vi.fn();
		const boom = new Error("listener bug");
		emitter.on("x", () => {
			throw boom;
		});
		emitter.on("x", after);

		const caught = new Promise((resolve) => {
			const handler = (err: unknown) => {
				process.off("uncaughtException", handler);
				resolve(err);
			};
			process.on("uncaughtException", handler);
		});
		expect(() => emitter.emit("x")).not.toThrow();
		expect(after).toHaveBeenCalledTimes(1);
		expect(await caught).toBe(boom);
	});

	it("drops an unheard event, including error", () => {
		const emitter = new Emitter();
		expect(() => emitter.emit("error", new Error("nobody listening"))).not.toThrow();
	});
});

describe("runtime portability", () => {
	const srcDir = join(import.meta.dirname, "../../src");
	const files = readdirSync(srcDir, { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith(".ts"));

	it.each(files)("src/%s imports no node: builtins", (file) => {
		const source = readFileSync(join(srcDir, file), "utf8");
		expect(source).not.toMatch(/from\s+["']node:|import\(\s*["']node:|require\(\s*["']node:/);
	});
});
