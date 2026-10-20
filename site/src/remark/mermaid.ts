import type { Root } from "mdast";

/**
 * Turns ```mermaid fences into `<pre class="mermaid">`, which public/mermaid.js renders in the
 * browser. Done before Expressive Code sees the fence, or it would be highlighted as code.
 */
export function remarkMermaid() {
	return (tree: Root) => {
		tree.children = tree.children.map((node) =>
			node.type === "code" && node.lang === "mermaid"
				? { type: "html", value: `<pre class="mermaid">${escapeHtml(node.value)}</pre>` }
				: node,
		);
	};
}

const escapeHtml = (s: string) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
