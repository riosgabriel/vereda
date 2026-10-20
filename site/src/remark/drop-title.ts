import type { Root } from "mdast";

/**
 * Removes a leading H1. The loader already copied it into `title`, and Starlight prints the
 * title as the page heading, so keeping it would show the heading twice.
 */
export function remarkDropTitle() {
	return (tree: Root) => {
		const first = tree.children.findIndex((node) => node.type !== "yaml" && node.type !== "html");
		const node = tree.children[first];
		if (node?.type === "heading" && node.depth === 1) tree.children.splice(first, 1);
	};
}
