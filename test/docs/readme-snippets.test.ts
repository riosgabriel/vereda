import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Typechecks every fenced `typescript`/`ts` code block in README.md against
 * the real library types, so a snippet that drifts from the actual API
 * surface fails CI instead of silently rotting.
 */

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const readmePath = fileURLToPath(new URL("../../README.md", import.meta.url));
const README = readFileSync(readmePath, "utf8");

interface CodeBlock {
	/** 1-based README line of the opening ``` fence. */
	fenceLine: number;
	/** Block source, exactly as it appears between the fences. */
	source: string;
}

function extractCodeBlocks(markdown: string): CodeBlock[] {
	const blocks: CodeBlock[] = [];
	const fenceRe = /```(typescript|ts)\r?\n([\s\S]*?)```/g;
	let match: RegExpExecArray | null;
	// biome-ignore lint/suspicious/noAssignInExpressions: standard regex exec loop
	while ((match = fenceRe.exec(markdown))) {
		const fenceLine = markdown.slice(0, match.index).split("\n").length;
		blocks.push({ fenceLine, source: match[2] });
	}
	return blocks;
}

/**
 * README snippets reference ambient things established by surrounding prose
 * (an existing `client`, an in-flight `ticket`, a `User` type, an `order`
 * object) that aren't meaningful to import. We declare them ambiently, but
 * only for a block that doesn't already declare/import the name itself —
 * otherwise tsc reports "Cannot redeclare".
 */
const AMBIENT_DECLARATIONS: Record<string, string> = {
	client: 'import type { HttpClient as __HttpClient } from "vereda";\ndeclare const client: __HttpClient;',
	ticket: 'import type { Ticket as __Ticket } from "vereda";\ndeclare const ticket: __Ticket<unknown>;',
	AppError: 'import type { AppError } from "vereda";',
	User: "type User = { id: number; name: string };",
	order: "declare const order: { id: string };",
};

function declaresOrImports(source: string, name: string): boolean {
	const declared = new RegExp(`\\b(?:const|let|var|type|interface|function|class)\\s+${name}\\b`);
	// Destructuring: `const { ticket } = …` / `const [client] = …`.
	const destructured = new RegExp(`\\b(?:const|let|var)\\s*[{[][^}\\]]*\\b${name}\\b[^}\\]]*[}\\]]`);
	// Imports may span lines (`import {\\n  AppError,\\n} from "vereda";`).
	const imported = new RegExp(`\\bimport\\b[^;]*\\b${name}\\b[^;]*\\bfrom\\b[^;]*;`);
	return declared.test(source) || destructured.test(source) || imported.test(source);
}

function buildPreamble(source: string): string {
	const lines: string[] = [];
	for (const [name, declaration] of Object.entries(AMBIENT_DECLARATIONS)) {
		const referenced = new RegExp(`\\b${name}\\b`).test(source);
		if (referenced && !declaresOrImports(source, name)) {
			lines.push(declaration);
		}
	}
	return lines.join("\n");
}

interface GeneratedFile {
	fileName: string;
	filePath: string;
	fenceLine: number;
	/** README line of the block's first content line (fence line + 1). */
	contentStartLine: number;
	/** 1-based line, within the generated file, of the block's first content line. */
	fileContentStartLine: number;
}

function generateFile(block: CodeBlock, dir: string): GeneratedFile {
	const preamble = buildPreamble(block.source);
	const lines: string[] = [];
	if (preamble) {
		lines.push(...preamble.split("\n"), "");
	}
	const fileContentStartLine = lines.length + 1;
	lines.push(...block.source.split("\n"));
	lines.push("", "export {};", "");

	const fileName = `block-L${block.fenceLine}.ts`;
	const filePath = path.join(dir, fileName);
	writeFileSync(filePath, lines.join("\n"), "utf8");

	return {
		fileName,
		filePath,
		fenceLine: block.fenceLine,
		contentStartLine: block.fenceLine + 1,
		fileContentStartLine,
	};
}

function writeTsconfig(dir: string): string {
	const tsconfigPath = path.join(dir, "tsconfig.json");
	const tsconfig = {
		compilerOptions: {
			target: "ES2022",
			module: "ESNext",
			moduleResolution: "Bundler",
			strict: true,
			esModuleInterop: true,
			skipLibCheck: true,
			forceConsistentCasingInFileNames: true,
			types: ["node"],
			typeRoots: [path.join(repoRoot, "node_modules/@types")],
			noEmit: true,
			paths: {
				vereda: [path.join(repoRoot, "src/core/index.ts")],
				"vereda/middleware": [path.join(repoRoot, "src/middleware/index.ts")],
				"vereda/zod": [path.join(repoRoot, "src/adapters/zod.ts")],
			},
		},
		include: ["*.ts"],
	};
	writeFileSync(tsconfigPath, JSON.stringify(tsconfig, null, 2), "utf8");
	return tsconfigPath;
}

/** Parses `path/to/file.ts(line,col): error TSxxxx: message` tsc diagnostics. */
function parseDiagnostics(output: string): Array<{ file: string; line: number; col: number; message: string }> {
	const diagnosticRe = /^(.*?\.ts)\((\d+),(\d+)\): (error .*)$/gm;
	const diagnostics: Array<{ file: string; line: number; col: number; message: string }> = [];
	let match: RegExpExecArray | null;
	// biome-ignore lint/suspicious/noAssignInExpressions: standard regex exec loop
	while ((match = diagnosticRe.exec(output))) {
		diagnostics.push({
			file: match[1],
			line: Number(match[2]),
			col: Number(match[3]),
			message: match[4],
		});
	}
	return diagnostics;
}

describe("README TypeScript snippets", () => {
	it("typecheck against the real library types", () => {
		const blocks = extractCodeBlocks(README);
		expect(blocks.length).toBeGreaterThan(0);

		const dir = mkdtempSync(path.join(tmpdir(), "vereda-readme-snippets-"));
		try {
			// Let bare specifiers like "zod" resolve the same way the mapped
			// `src/adapters/zod.ts` resolves them: by walking up from the file
			// to a `node_modules` directory.
			symlinkSync(path.join(repoRoot, "node_modules"), path.join(dir, "node_modules"), "dir");

			const generated = blocks.map((block) => generateFile(block, dir));
			const tsconfigPath = writeTsconfig(dir);

			const tscBin = path.join(repoRoot, "node_modules", ".bin", "tsc");
			// Spawn the tsc binary directly (relying on its `#!/usr/bin/env node`
			// shebang) rather than via `process.execPath`, so this always runs
			// under real Node even when the test suite itself runs under Bun.
			const result = spawnSync(tscBin, ["-p", tsconfigPath, "--noEmit"], {
				encoding: "utf8",
				cwd: repoRoot,
			});

			if (result.status === 0) {
				return;
			}
			if (result.error) {
				throw new Error(`Could not run ${tscBin} (dependencies installed?): ${result.error.message}`);
			}

			const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
			const diagnostics = parseDiagnostics(output);
			const byFile = new Map(generated.map((g) => [g.filePath, g]));

			const messages = diagnostics.map((d) => {
				const file = byFile.get(path.resolve(repoRoot, d.file));
				if (!file) {
					return `${d.file}(${d.line},${d.col}): ${d.message}`;
				}
				const readmeLine = file.contentStartLine + (d.line - file.fileContentStartLine);
				return `README.md:${readmeLine} (block starting at README.md:${file.fenceLine}, ${file.fileName}:${d.line}:${d.col}): ${d.message}`;
			});

			throw new Error(
				`README TypeScript snippet(s) failed to typecheck:\n${messages.join("\n")}\n\nFull tsc output:\n${output}`,
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}, 60_000);

	it("has no JavaScript-flavored fences that would dodge the typecheck", () => {
		// Only `typescript`/`ts` fences are checked above, so retagging a block
		// `js` would silently exempt it. Examples are TypeScript; keep them so.
		const dodging = [...README.matchAll(/^```(js|javascript|jsx|tsx|mjs|cjs)\s*$/gm)].map(
			(m) => `README.md:${README.slice(0, m.index).split("\n").length} (\`\`\`${m[1]})`,
		);
		expect(dodging).toEqual([]);
	});
});
