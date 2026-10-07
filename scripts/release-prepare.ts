/**
 * Prepares a release PR: bumps `package.json` and dates the CHANGELOG.
 *
 *   npm run release:prepare            # infer the bump from [Unreleased]
 *   npm run release:prepare -- minor   # or say it: patch | minor | major | X.Y.Z
 *
 * It only edits files. Merging the resulting PR is what releases: release.yml
 * runs on the push to main, sees a version with no tag yet, and stages it on
 * npm for maintainer approval (see CONTRIBUTING.md, "Releasing").
 */
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export type Bump = "patch" | "minor" | "major";

const BUMPS: readonly Bump[] = ["patch", "minor", "major"];
const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;
const UNRELEASED_HEADING = "## [Unreleased]";

/** The body of `## [Unreleased]`, up to the next version heading or the link block. */
export function unreleasedSection(changelog: string): string {
	const start = changelog.indexOf(UNRELEASED_HEADING);
	if (start === -1) throw new Error(`CHANGELOG.md has no "${UNRELEASED_HEADING}" heading`);
	const rest = changelog.slice(start + UNRELEASED_HEADING.length);
	const end = rest.search(/^## \[|^\[[^\]]+\]:\s/m);
	return (end === -1 ? rest : rest.slice(0, end)).trim();
}

/** The smallest semver bump the [Unreleased] entries call for (Keep a Changelog headings). */
export function inferBump(section: string): Bump {
	if (/^### (Removed|Breaking)/im.test(section)) return "major";
	if (/^### (Added|Changed|Deprecated)/im.test(section)) return "minor";
	return "patch";
}

export function nextVersion(current: string, bump: Bump | string): string {
	const m = SEMVER.exec(current);
	if (!m) throw new Error(`package.json version "${current}" isn't plain X.Y.Z`);
	const [major, minor, patch] = m.slice(1).map(Number);
	switch (bump) {
		case "major":
			return `${major + 1}.0.0`;
		case "minor":
			return `${major}.${minor + 1}.0`;
		case "patch":
			return `${major}.${minor}.${patch + 1}`;
		default:
			if (!SEMVER.test(bump)) throw new Error(`"${bump}" is not patch, minor, major or X.Y.Z`);
			return bump;
	}
}

function compareVersions(a: string, b: string): number {
	const pa = a.split(".").map(Number);
	const pb = b.split(".").map(Number);
	for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
	return 0;
}

/** Turns [Unreleased] into a dated version section and updates the compare links. */
export function dateChangelog(changelog: string, from: string, to: string, date: string): string {
	const repoLink = /^\[Unreleased\]: (https:\/\/\S+)\/compare\/v[^.\s]+\.[^.\s]+\.[^.\s]+\.\.\.HEAD$/m.exec(changelog);
	if (!repoLink) throw new Error("CHANGELOG.md has no [Unreleased] compare link to update");
	const repo = repoLink[1];
	return changelog
		.replace(UNRELEASED_HEADING, `${UNRELEASED_HEADING}\n\n## [${to}] - ${date}`)
		.replace(repoLink[0], `[Unreleased]: ${repo}/compare/v${to}...HEAD\n[${to}]: ${repo}/compare/v${from}...v${to}`);
}

export interface Plan {
	from: string;
	to: string;
	inferred: Bump;
	changelog: string;
}

/** Validates and computes the release. `requested` is undefined to use the inferred bump. */
export function planRelease(
	version: string,
	changelog: string,
	requested: string | undefined,
	date: string,
	force = false,
): Plan {
	const section = unreleasedSection(changelog);
	if (section === "") throw new Error("[Unreleased] is empty: nothing to release");
	const inferred = inferBump(section);
	const to = nextVersion(version, requested ?? inferred);
	if (compareVersions(to, version) <= 0) throw new Error(`${to} is not greater than the current ${version}`);
	const floor = nextVersion(version, inferred);
	if (!force && compareVersions(to, floor) < 0) {
		throw new Error(
			`[Unreleased] calls for at least a ${inferred} bump (${floor}), not ${to}. Pass --force if the headings overstate it.`,
		);
	}
	return { from: version, to, inferred, changelog: dateChangelog(changelog, version, to, date) };
}

function main(argv: string[]): void {
	const force = argv.includes("--force");
	const requested = argv.find((a) => !a.startsWith("--"));
	if (requested !== undefined && !BUMPS.includes(requested as Bump) && !SEMVER.test(requested)) {
		throw new Error(`usage: npm run release:prepare -- [patch|minor|major|X.Y.Z] [--force]`);
	}
	const pkgText = readFileSync("package.json", "utf8");
	const version = (JSON.parse(pkgText) as { version: string }).version;
	const today = new Date().toISOString().slice(0, 10);
	const plan = planRelease(version, readFileSync("CHANGELOG.md", "utf8"), requested, today, force);

	writeFileSync("package.json", pkgText.replace(`"version": "${version}"`, `"version": "${plan.to}"`));
	writeFileSync("CHANGELOG.md", plan.changelog);

	console.log(`${plan.from} → ${plan.to} (${requested ?? `inferred ${plan.inferred}`})\n`);
	console.log("Review the diff, then open the release PR:");
	console.log(`  git switch -c chore/release-${plan.to}`);
	console.log(`  git commit -am "chore(release): prepare ${plan.to}"`);
	console.log(`  git push -u origin HEAD && gh pr create --fill`);
	console.log("\nMerging it releases: release.yml stages the version on npm, then you approve it with 2FA.");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	try {
		main(process.argv.slice(2));
	} catch (err) {
		console.error(`release:prepare: ${err instanceof Error ? err.message : String(err)}`);
		process.exit(1);
	}
}
