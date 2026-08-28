import type { ZodType, ZodTypeDef } from "zod"
import type { ParseFn } from "../core/types.js"

/**
 * Wraps a Zod schema into a ParseFn for use with relay's `parse` option.
 *
 * @example
 * const UserSchema = z.object({ id: z.number(), name: z.string() });
 *
 * const ticket = client.get('/users/1', {
 *   parse: withZod(UserSchema),
 * });
 */
export function withZod<T>(schema: ZodType<T, ZodTypeDef, unknown>): ParseFn<T> {
  return (data: unknown): T => schema.parse(data)
}
