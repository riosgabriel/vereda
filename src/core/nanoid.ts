export function nanoid(size = 21): string {
	const bytes = crypto.getRandomValues(new Uint8Array(size));
	const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";
	let id = "";
	for (let i = 0; i < size; i++) {
		id += chars[bytes[i]! & 63];
	}
	return id;
}
