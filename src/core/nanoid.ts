import { randomBytes } from "node:crypto";

export function nanoid(size = 21): string {
  const bytes = randomBytes(size);
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";
  let id = "";
  for (let i = 0; i < size; i++) {
    id += chars[bytes[i]! & 63];
  }
  return id;
}
