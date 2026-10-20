import type { Blockquote, Root } from "mdast";

/**
 * Gives the docs' blockquotes a kind, so the site can style them as callouts while the Markdown
 * stays plain for GitHub. A blockquote is classified by how it opens:
 *
 *   > [!WARNING] …             → callout--warning (GitHub alert syntax; the marker is removed,
 *                                 also [!NOTE], [!TIP], [!IMPORTANT], [!CAUTION])
 *   > **Crux:** …              → callout--crux (the question a book chapter answers)
 *   > **See it run:** …        → callout--demo (a link to a pattern simulator)
 *   > **Aside …**              → callout--aside (a story beside the main text)
 *
 * Any other blockquote stays a plain quote.
 */
export function remarkCallouts() {
	return (tree: Root) => {
		visitBlockquotes(tree, (quote) => {
			const kind = alertKind(quote) ?? labelKind(quote);
			if (!kind) return;
			quote.data = { ...quote.data, hProperties: { className: ["callout", `callout--${kind}`] } };
		});
	};
}

const ALERT = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*/;

/** GitHub alerts: strips the `[!KIND]` marker and returns the kind, lower-cased. */
function alertKind(quote: Blockquote): string | undefined {
	const first = quote.children[0];
	const text = first?.type === "paragraph" ? first.children[0] : undefined;
	if (text?.type !== "text") return undefined;
	const match = ALERT.exec(text.value);
	if (!match?.[1]) return undefined;
	text.value = text.value.slice(match[0].length);
	if (!text.value && first?.type === "paragraph") first.children.shift();
	const kind = match[1].toLowerCase();
	return kind === "caution" ? "warning" : kind;
}

/** The book's labelled blockquotes: the kind comes from the bold label they open with. */
function labelKind(quote: Blockquote): string | undefined {
	const first = quote.children[0];
	const strong = first?.type === "paragraph" ? first.children[0] : undefined;
	if (strong?.type !== "strong" || strong.children[0]?.type !== "text") return undefined;
	const label = strong.children[0].value;
	if (label.startsWith("Crux")) return "crux";
	if (label.startsWith("See it run")) return "demo";
	if (label.startsWith("Aside")) return "aside";
	return undefined;
}

function visitBlockquotes(node: { children?: unknown[] }, fn: (quote: Blockquote) => void) {
	for (const child of (node.children ?? []) as { type: string; children?: unknown[] }[]) {
		if (child.type === "blockquote") fn(child as Blockquote);
		if (child.children) visitBlockquotes(child, fn);
	}
}
