// ---------------------------------------------------------------------------
// URL redaction for safe logging
// ---------------------------------------------------------------------------

/** Userinfo in an absolute URL's authority: `scheme://user:pass@`. Greedy up
 *  to the last `@` before the path/query/fragment, as the URL spec parses it. */
const USERINFO = /^([a-zA-Z][a-zA-Z\d+.-]*:\/\/)[^/?#]*@/;

/**
 * Redacts the secret-bearing parts of a URL for safe logging: userinfo
 * credentials become `[redacted]@`, and each query parameter value becomes
 * `[redacted]` while its key is preserved.
 *
 * Example: `https://bob:hunter2@api.example.com/auth?token=abc123&user=joe`
 *      → `https://[redacted]@api.example.com/auth?token=[redacted]&user=[redacted]`
 *
 * URLs with neither are returned unchanged.
 */
export function redactUrl(url: string): string {
	const withoutUserinfo = url.replace(USERINFO, "$1[redacted]@");
	return redactQueryValues(withoutUserinfo);
}

function redactQueryValues(url: string): string {
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
