import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { inferBump, nextVersion, planRelease, unreleasedSection } from "../../scripts/release-prepare.ts";

const changelog = (unreleased: string) => `# Changelog

## [Unreleased]
${unreleased}
## [1.0.2] - 2026-10-07

### Fixed

- something

[Unreleased]: https://github.com/riosgabriel/vereda/compare/v1.0.2...HEAD
[1.0.2]: https://github.com/riosgabriel/vereda/compare/v1.0.1...v1.0.2
`;

describe("release:prepare", () => {
	it("infers the smallest bump from the [Unreleased] headings", () => {
		expect(inferBump("### Fixed\n\n- a")).toBe("patch");
		expect(inferBump("### Fixed\n\n- a\n\n### Added\n\n- b")).toBe("minor");
		expect(inferBump("### Changed\n\n- a")).toBe("minor");
		expect(inferBump("### Removed\n\n- a")).toBe("major");
	});

	it("computes the next version", () => {
		expect(nextVersion("1.0.2", "patch")).toBe("1.0.3");
		expect(nextVersion("1.0.2", "minor")).toBe("1.1.0");
		expect(nextVersion("1.0.2", "major")).toBe("2.0.0");
		expect(nextVersion("1.0.2", "1.2.0")).toBe("1.2.0");
		expect(() => nextVersion("1.0.2", "1.2")).toThrow(/not patch, minor, major or X.Y.Z/);
	});

	it("dates [Unreleased], keeps an empty [Unreleased], and updates the compare links", () => {
		const plan = planRelease("1.0.2", changelog("\n### Added\n\n- redirect option\n"), undefined, "2026-11-01");

		expect(plan.to).toBe("1.1.0");
		expect(plan.changelog).toContain("## [Unreleased]\n\n## [1.1.0] - 2026-11-01\n\n### Added\n\n- redirect option");
		expect(plan.changelog).toContain(
			"[Unreleased]: https://github.com/riosgabriel/vereda/compare/v1.1.0...HEAD\n" +
				"[1.1.0]: https://github.com/riosgabriel/vereda/compare/v1.0.2...v1.1.0\n" +
				"[1.0.2]: https://github.com/riosgabriel/vereda/compare/v1.0.1...v1.0.2",
		);
		expect(unreleasedSection(plan.changelog)).toBe("");
	});

	it("refuses a bump smaller than the entries call for, unless forced", () => {
		const added = changelog("\n### Added\n\n- redirect option\n");

		expect(() => planRelease("1.0.2", added, "patch", "2026-11-01")).toThrow(/at least a minor bump \(1\.1\.0\)/);
		expect(planRelease("1.0.2", added, "patch", "2026-11-01", true).to).toBe("1.0.3");
		expect(planRelease("1.0.2", added, "major", "2026-11-01").to).toBe("2.0.0");
	});

	it("refuses an empty [Unreleased] and a version that doesn't move forward", () => {
		expect(() => planRelease("1.0.2", changelog("\n"), undefined, "2026-11-01")).toThrow(/nothing to release/);
		expect(() => planRelease("1.0.2", changelog("\n### Fixed\n\n- a\n"), "1.0.2", "2026-11-01")).toThrow(
			/not greater than/,
		);
	});

	it("parses the real CHANGELOG.md", () => {
		expect(() => unreleasedSection(readFileSync("CHANGELOG.md", "utf8"))).not.toThrow();
	});
});
