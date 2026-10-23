import type { Blockquote, Heading, PhrasingContent, Root, RootContent } from "mdast";

/**
 * Gives the docs' blockquotes a kind, so the site can style them as callouts while the Markdown
 * stays plain for GitHub. A blockquote is classified by how it opens:
 *
 *   > [!WARNING] …             → callout--warning (GitHub alert syntax; the marker is removed,
 *                                 also [!NOTE], [!TIP], [!IMPORTANT], [!CAUTION])
 *   > **Crux:** …              → callout--crux (the question a book chapter answers)
 *   > **See it run:** …        → callout--demo (a link to a pattern simulator)
 *   > **Aside: title.** …      → callout--aside (a story beside the main text; also "Aside — title.")
 *
 * Any other blockquote stays a plain quote. The book's labels become a small heading above the
 * text (`.callout-label`), and an aside keeps its title in bold.
 *
 * The book's recurring sections are wrapped in a `<section>` with a kind too, from their `##`
 * heading: "Design note: …", "What must stay true" (the invariants) and "Try it".
 *
 * scripts/book-download.ts applies the same rules to the EPUB and PDF, from CALLOUTS and SECTIONS.
 */
export function remarkCallouts() {
	return (tree: Root) => {
		visitBlockquotes(tree, (quote) => {
			const kind = alertKind(quote) ?? labelKind(quote);
			if (!kind) return;
			quote.data = { ...quote.data, hProperties: { className: ["callout", `callout--${kind}`] } };
		});
		wrapSections(tree);
	};
}

/** The book's labelled blockquotes: what the bold opening matches, its kind, and the label shown. */
export const CALLOUTS = [
	{ match: /^Crux:\s*/, kind: "crux", label: "Crux" },
	{ match: /^See it run:\s*/, kind: "demo", label: "See it run" },
	{ match: /^Aside(?::| —)\s*/, kind: "aside", label: "Aside" },
] as const;

/** The book's recurring `##` sections: what the heading matches, its kind, and a label if any. */
export const SECTIONS = [
	{ match: /^Design note:\s*/, kind: "design-note", label: "Design note" },
	{ match: /^What must stay true$/, kind: "invariants", label: undefined },
	{ match: /^Try it$/, kind: "try-it", label: undefined },
] as const;

/** "two fixes in these lines." → "Two fixes in these lines.", once the label is taken off. */
export const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

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

/** The book's labelled blockquotes: the bold opening becomes a label, plus a title if it has one. */
function labelKind(quote: Blockquote): string | undefined {
	const first = quote.children[0];
	if (first?.type !== "paragraph") return undefined;
	const strong = first.children[0];
	const text = strong?.type === "strong" ? strong.children[0] : undefined;
	if (text?.type !== "text") return undefined;
	const callout = CALLOUTS.find((c) => c.match.test(text.value));
	if (!callout || strong?.type !== "strong") return undefined;
	text.value = capitalize(text.value.replace(callout.match, ""));
	if (!text.value) strong.children.shift();
	first.children.splice(0, strong.children.length ? 0 : 1, labelNode(callout.label));
	return callout.kind;
}

/**
 * A label, as `<span class="callout-label">Crux<span class="callout-sep">: </span></span>`. The
 * hidden ": " keeps "Crux: What happens…" whole for screen readers and in the page's contents.
 */
function labelNode(label: string): PhrasingContent {
	const span = (className: string, children: PhrasingContent[]) =>
		({ type: "emphasis", children, data: { hName: "span", hProperties: { className: [className] } } }) as const;
	return span("callout-label", [{ type: "text", value: label }, span("callout-sep", [{ type: "text", value: ": " }])]);
}

/** Wraps each recurring `##` section, its heading up to the next `#` or `##`, in a `<section>`. */
function wrapSections(tree: Root) {
	const out: RootContent[] = [];
	let open: { children: RootContent[] } | undefined;
	for (const node of tree.children) {
		if (node.type === "heading" && node.depth <= 2) open = undefined;
		const kind = node.type === "heading" && node.depth === 2 ? sectionKind(node) : undefined;
		if (kind) {
			open = { children: [] };
			// mdast has no section node; an unknown node with children becomes the element in data.hName.
			out.push({
				type: "bookSection",
				children: open.children,
				data: { hName: "section", hProperties: { className: ["book-section", `book-section--${kind}`] } },
			} as unknown as RootContent);
		}
		(open?.children ?? out).push(node);
	}
	tree.children = out;
}

function sectionKind(heading: Heading): string | undefined {
	const text = heading.children[0];
	if (text?.type !== "text") return undefined;
	const section = SECTIONS.find((s) => s.match.test(text.value));
	if (!section) return undefined;
	if (section.label) {
		text.value = capitalize(text.value.replace(section.match, ""));
		heading.children.unshift(labelNode(section.label));
	}
	return section.kind;
}

function visitBlockquotes(node: { children?: unknown[] }, fn: (quote: Blockquote) => void) {
	for (const child of (node.children ?? []) as { type: string; children?: unknown[] }[]) {
		if (child.type === "blockquote") fn(child as Blockquote);
		if (child.children) visitBlockquotes(child, fn);
	}
}
