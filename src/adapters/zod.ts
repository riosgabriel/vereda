import type { ZodType } from "zod";
import type { ParseFn } from "../core/types.ts";

/**
 * Wraps a Zod schema into a ParseFn for use with vereda's `parse` option.
 * Uses `parseAsync`, so schemas with async refinements/transforms work too.
 *
 * @example
 * const UserSchema = z.object({ id: z.number(), name: z.string() });
 *
 * const ticket = client.get('/users/1', {
 *   parse: withZod(UserSchema),
 * });
 */
export function withZod<T>(schema: ZodType<T>): ParseFn<T> {
	return (data: unknown): Promise<T> => schema.parseAsync(data);
}
