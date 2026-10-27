import type { Paragraph, PhrasingContent, Root, RootContent } from "mdast";

/**
 * Pandoc's definition lists, which the glossary uses and the EPUB/PDF build already reads:
 *
 *   **Term**
 *   : Definition, wrapped onto
 *     more lines.
 *
 * CommonMark parses each entry as one paragraph whose text breaks at "\n: ". This splits it there
 * into a `<dt>` and a `<dd>`, and gathers neighbouring entries into one `<dl>`. On GitHub the
 * source still reads as a bold term over its definition.
 */
export function remarkDefinitionList() {
	return (tree: Root) => {
		const out: RootContent[] = [];
		let list: { children: RootContent[] } | undefined;
		for (const node of tree.children) {
			const entry = node.type === "paragraph" ? splitEntry(node) : undefined;
			if (!entry) {
				list = undefined;
				out.push(node);
				continue;
			}
			if (!list) {
				list = { children: [] };
				// mdast has no definition-list node; an unknown node with children becomes data.hName.
				out.push({ type: "definitionList", children: list.children, data: { hName: "dl" } } as unknown as RootContent);
			}
			list.children.push(
				{ type: "definitionTerm", children: entry.term, data: { hName: "dt" } } as unknown as RootContent,
				{ type: "definitionDescription", children: entry.description, data: { hName: "dd" } } as unknown as RootContent,
			);
		}
		tree.children = out;
	};
}

const MARKER = "\n: ";

/** The term (everything before the first "\n: ") and the description (everything after it). */
function splitEntry(paragraph: Paragraph): { term: PhrasingContent[]; description: PhrasingContent[] } | undefined {
	const at = paragraph.children.findIndex((child) => child.type === "text" && child.value.includes(MARKER));
	const text = paragraph.children[at];
	if (at < 1 || text?.type !== "text") return undefined;
	const [before = "", ...rest] = text.value.split(MARKER);
	// The term is one line: a break before the marker means this is ordinary prose.
	if (before.includes("\n") || paragraph.children.slice(0, at).some((c) => c.type === "text" && c.value.includes("\n")))
		return undefined;
	const term = [...paragraph.children.slice(0, at), ...(before ? [{ type: "text", value: before } as const] : [])];
	const description = [{ type: "text", value: rest.join(MARKER) } as const, ...paragraph.children.slice(at + 1)];
	return { term, description };
}
