// ---------------------------------------------------------------------------
// URL redaction for safe logging
// ---------------------------------------------------------------------------

/**
 * Redacts query parameter values in a URL, replacing each value with
 * `[redacted]` while preserving parameter keys.
 *
 * Example: `https://api.example.com/auth?token=abc123&user=joe`
 *      → `https://api.example.com/auth?token=[redacted]&user=[redacted]`
 *
 * URLs without query strings are returned unchanged.
 */
export function redactUrl(url: string): string {
	const qIdx = url.indexOf("?");
	if (qIdx === -1) return url;

	const base = url.slice(0, qIdx);
	const rest = url.slice(qIdx + 1);

	// Separate fragment from query string (# is the fragment delimiter)
	const fIdx = rest.indexOf("#");
	const query = fIdx === -1 ? rest : rest.slice(0, fIdx);
	const fragment = fIdx === -1 ? "" : rest.slice(fIdx);

	const redacted = query
		.split("&")
		.map((pair) => {
			const eqIdx = pair.indexOf("=");
			if (eqIdx === -1) return pair; // bare key, no value
			return `${pair.slice(0, eqIdx + 1)}[redacted]`;
		})
		.join("&");

	return `${base}?${redacted}${fragment}`;
}
