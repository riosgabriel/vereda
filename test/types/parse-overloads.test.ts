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
});
