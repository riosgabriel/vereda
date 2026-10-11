import { describe, expectTypeOf, it } from "vitest";
import { HttpClient, json, type ParseFn, type Ticket } from "../../src/core/index.ts";

// Type-level only: these assertions are checked by `npm run typecheck`.
describe("parse overloads", () => {
	const client = HttpClient.create({ timeout: { attemptMs: 1_000 } });

	it("types data as T only when parse is given", () => {
		type User = { name: string };
		const lazy = () => {
			expectTypeOf(client.get("/u", { parse: json<User>() })).toEqualTypeOf<Ticket<User>>();
			expectTypeOf(client.post("/u", "{}", { parse: json<User>() })).toEqualTypeOf<Ticket<User>>();
			expectTypeOf(client.request("/u", { method: "PUT", parse: json<User>() })).toEqualTypeOf<Ticket<User>>();

			expectTypeOf(client.get("/u")).toEqualTypeOf<Ticket<undefined>>();
			expectTypeOf(client.get("/u", { parse: undefined })).toEqualTypeOf<Ticket<undefined>>();
			expectTypeOf(client.delete("/u")).toEqualTypeOf<Ticket<undefined>>();
			expectTypeOf(client.post("/u", "{}")).toEqualTypeOf<Ticket<undefined>>();

			const conditional = (parse: ParseFn<User> | undefined) => client.request("/u", { parse });
			expectTypeOf(conditional).returns.toEqualTypeOf<Ticket<User | undefined>>();

			// @ts-expect-error — a type argument without parse would claim a body that is never read
			client.get<User>("/u");
			// @ts-expect-error — same for body-carrying methods
			client.post<User>("/u", "{}");
		};
		void lazy;
	});

	it("types data from responseType when there is no parse (#142)", () => {
		const lazy = () => {
			expectTypeOf(client.get("/u", { responseType: "json" })).toEqualTypeOf<Ticket<unknown>>();
			expectTypeOf(client.get("/u", { responseType: "text" })).toEqualTypeOf<Ticket<string>>();
			expectTypeOf(client.get("/u", { responseType: "arrayBuffer" })).toEqualTypeOf<Ticket<ArrayBuffer>>();
			expectTypeOf(client.get("/u", { responseType: "blob" })).toEqualTypeOf<Ticket<Blob>>();
			expectTypeOf(client.delete("/u", { responseType: "none" })).toEqualTypeOf<Ticket<undefined>>();
			expectTypeOf(client.post("/u", "{}", { responseType: "text" })).toEqualTypeOf<Ticket<string>>();
			expectTypeOf(client.request("/u", { method: "PUT", responseType: "blob" })).toEqualTypeOf<Ticket<Blob>>();

			// parse wins: data is what parse returns, whatever the read mode
			expectTypeOf(client.get("/u", { responseType: "text", parse: (s) => String(s).length })).toEqualTypeOf<
				Ticket<number>
			>();
		};
		void lazy;
	});

	it("unwraps an async parse (#142)", () => {
		type User = { name: string };
		const lazy = () => {
			const parseAsync: ParseFn<User> = async (data) => data as User;
			expectTypeOf(client.get("/u", { parse: parseAsync })).toEqualTypeOf<Ticket<User>>();
			expectTypeOf(client.get("/u", { parse: async () => 1 })).toEqualTypeOf<Ticket<number>>();
		};
		void lazy;
	});
});
