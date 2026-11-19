// The values a project's declared build arguments actually have, read
// out of the repository's own files (issue #355).
//
// Two builds are built from one `Dockerfile.inspector`, and each
// resolves these for itself, from the tree it is building against:
//
//   - **Inspector's check box**, at the commit under check. Inspector's
//     own half (task 1 of this pair) - nothing here is involved.
//   - **Fabrica's machine image**, from the build context, which is the
//     registered project's checkout. That is the same tree whose
//     manifest and lockfile that build's own `COPY` lines read
//     (`--build-context repo=<project>`), and the same tree the
//     project's `Dockerfile.inspector` and `buildSecrets` list are
//     already read from.
//
// Why the build context and not origin's tip (which is where a first
// round's worktree is cut from): `.ruby-version` is itself one of the
// files copied in for `bundle install` to read, so a `FROM` resolved
// from one commit while the Gemfile beside it comes from another is the
// one combination that cannot work - bundler refuses the build naming
// both versions, which is the exact failure issue #355 is about,
// arrived at from the other side. One tree, one answer.
//
// What this never does is read a file the config did not name. The
// primary-then-fallback order (`.node-version`, then `.nvmrc`, then
// `.tool-versions`) decides which file an entry is *written* against -
// `fabrica register` and `fabrica doctor --fix`, through
// `declaredVersionFor`. Once written, the entry is the declaration, and
// Inspector resolves the very same entry against the very same file: a
// Fabrica that quietly fell back to a second file would build the
// worker's box on one version and the check box on another, which is
// worse than saying the declaration has gone stale.
//
// This module reads and answers. It passes nothing to docker, decides
// nothing about staleness, and prints nothing: `src/projectimage/` turns
// the answer into `--build-arg` flags and into the image's stamp, and
// `fabrica doctor` turns it into a line.

import {
  unusableValueReason,
  usableValue,
  valueFromText,
  type DeclaredBuildArgs,
  type ReadRepoFile,
} from "./versions.ts";

/** One declared argument that could not be given a value, and why -
 * never dropped silently, since the build then falls back to whatever
 * default the Dockerfile carries and that is exactly the stale version
 * issue #355 is about. */
export interface UnresolvedBuildArg {
  name: string;
  file: string;
  /** One line, for a doctor line or a build's own report. */
  reason: string;
}

export interface ResolvedBuildArgs {
  /** Name to value, for every argument that resolved - what goes on the
   * `docker build` argv and into the image's stamp. */
  values: Record<string, string>;
  /** Every argument that did not, with the reason. */
  unresolved: UnresolvedBuildArg[];
}

/**
 * Every declared argument's value, read out of one tree.
 *
 * An argument whose file is not there, whose file names nothing, or
 * whose value could not be a Docker tag is reported in `unresolved`
 * rather than passed - a build argument with a wrong value would name a
 * different image, and one with no value at all would resolve to the
 * empty string if the Dockerfile carried no default.
 */
export function resolveBuildArgs(declared: DeclaredBuildArgs, read: ReadRepoFile): ResolvedBuildArgs {
  const values: Record<string, string> = {};
  const unresolved: UnresolvedBuildArg[] = [];

  for (const [name, source] of Object.entries(declared)) {
    const text = read(source.file);
    if (text === null) {
      unresolved.push({
        name,
        file: source.file,
        reason: `${source.file} is not in this project, so there is nothing to read ${name} from`,
      });
      continue;
    }
    const value = valueFromText(text, source.pattern);
    if (value === null) {
      unresolved.push({
        name,
        file: source.file,
        reason:
          source.pattern === undefined
            ? `${source.file} is empty, so it names no value for ${name}`
            : `no line in ${source.file} matches ${name}'s own pattern (${source.pattern})`,
      });
      continue;
    }
    if (!usableValue(value)) {
      unresolved.push({
        name,
        file: source.file,
        reason: `${source.file} names ${name} as something no image tag could be: ${unusableValueReason(value)}`,
      });
      continue;
    }
    values[name] = value;
  }

  return { values, unresolved };
}

/** The resolved values as `--build-arg NAME=value` pairs, in a fixed
 * order (by name) so one build's argv and the next's can be compared -
 * and so the image's stamp over them is stable whatever order the
 * config happened to list them in. */
export function buildArgFlags(values: Record<string, string>): string[] {
  return Object.keys(values)
    .sort()
    .flatMap((name) => ["--build-arg", `${name}=${values[name]}`]);
}

/** The resolved values as one canonical line, which is what the image's
 * stamp is taken over (`machineImageStamp`). Sorted for the same reason
 * the flags are: the stamp must move when a value moves and never
 * because a config was reordered. */
export function buildArgsFingerprint(values: Record<string, string>): string {
  return Object.keys(values)
    .sort()
    .map((name) => `${name}=${values[name]}`)
    .join("\n");
}
