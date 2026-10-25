// The fixed vocabulary (issue #204: "The vocabulary of questions is fixed
// in code; a line can only combine them"), and the two path conventions
// two of those questions are answered against.
//
// Why these live in code rather than in the rules file: a rules file that
// could also define what counts as a test file, or which manifests mean a
// new dependency, would be a file that can widen its own questions. The
// Client combines questions; he does not write them, and he does not
// write what they mean either.

import type { ConditionKey } from "./types.ts";

/** Every condition key, in the order a `would-close-by-rule` event lists
 * its answers - coarsest fact first, so a reader scanning one event sees
 * "what was touched" before "how much of it". */
export const CONDITION_KEYS: readonly ConditionKey[] = [
  "allowedFolders",
  "noTestFiles",
  "noDependencyManifest",
  "maxFiles",
  "maxLines",
  "inspectorGreen",
  "requiredGreenChecks",
  "noQuestionsAsked",
  "noCouldNotVerify",
] as const;

/**
 * What a test file looks like, as a path. Deliberately broad across
 * ecosystems rather than tuned to this repository: the question is asked
 * of whichever project the rules file belongs to, and the direction a
 * "no test files touched" condition must fail in is "call it a test when
 * unsure", never the other way.
 *
 * Covers a `*.test.*` / `*_test.*` / `*.spec.*` basename, a bare
 * `test.*`/`tests.*` basename, and any path with a `test`, `tests`,
 * `__tests__`, `spec` or `testdata` segment in it.
 */
export function isTestFile(path: string): boolean {
  const segments = path.split("/").filter((segment) => segment.length > 0);
  const base = segments[segments.length - 1] ?? "";
  if (segments.slice(0, -1).some((segment) => TEST_DIR_SEGMENTS.has(segment.toLowerCase()))) return true;
  const lower = base.toLowerCase();
  if (/(^|[._-])(test|tests|spec)([._-]|$)/.test(lower)) return true;
  return false;
}

const TEST_DIR_SEGMENTS = new Set(["test", "tests", "__tests__", "spec", "specs", "testdata"]);

/**
 * The files that declare or pin a project's dependencies. A change to any
 * of them answers "no new dependency" unsafe - including a lock file
 * alone, which is how a transitive dependency arrives without the
 * manifest moving at all.
 *
 * Matched on the basename, so a manifest anywhere in the tree counts, not
 * only one at the root: a monorepo's `packages/ui/package.json` is as
 * much a dependency change as the root's.
 */
export function isDependencyManifest(path: string): boolean {
  const base = path.split("/").pop() ?? "";
  return DEPENDENCY_MANIFESTS.has(base);
}

const DEPENDENCY_MANIFESTS = new Set([
  "package.json",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lockb",
  "go.mod",
  "go.sum",
  "requirements.txt",
  "requirements.in",
  "constraints.txt",
  "Pipfile",
  "Pipfile.lock",
  "pyproject.toml",
  "poetry.lock",
  "uv.lock",
  "Cargo.toml",
  "Cargo.lock",
  "Gemfile",
  "Gemfile.lock",
  "composer.json",
  "composer.lock",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "gradle.lockfile",
  "Package.swift",
  "Package.resolved",
  "mix.exs",
  "mix.lock",
]);

/** Whether `path` sits under `folder`, with `folder` read as a directory
 * prefix - so `src` matches `src/a.ts` but never `srcery/a.ts`. A folder
 * written as `.` (or empty) means the whole repository, which the loader
 * refuses: a condition that allows everything is not a condition. */
export function isUnderFolder(path: string, folder: string): boolean {
  const prefix = folder.endsWith("/") ? folder : `${folder}/`;
  return path === folder || path.startsWith(prefix);
}
