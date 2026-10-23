export function nanoid(size = 21): string {
	const bytes = crypto.getRandomValues(new Uint8Array(size));
	const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";
	let id = "";
	for (let i = 0; i < size; i++) {
		id += chars[bytes[i]! & 63];
	}
	return id;
}

/** RFC 4122 version 4 UUID from `crypto.getRandomValues`, which every
 *  supported runtime has (unlike `crypto.randomUUID`, absent in insecure
 *  browser contexts). */
export function uuidV4(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(16));
	bytes[6] = (bytes[6]! & 0x0f) | 0x40;
	bytes[8] = (bytes[8]! & 0x3f) | 0x80;
	const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
