// Turning a `Dockerfile.inspector` that hard-codes a version into one
// that reads it from the repository (issue #355).
//
// This is the "existing projects are converted automatically" half: a
// project registered before any of this carries `FROM ruby:3.4.8`, and
// the repository it belongs to now says 3.4.13 in `.ruby-version`. The
// conversion writes the two lines `fabrica register` would write today
// and the `.inspector.json` entry that feeds them.
//
// It rewrites text and composes the config entry; it writes no file,
// backs nothing up, prints nothing and builds nothing. `src/cli/
// version-pins.ts` does all four, for the one case where it is allowed
// to: a terms folder outside the repository. Terms committed **inside**
// a repository are never edited by Fabrica - the same standing rule
// `src/inspector/config-check.ts` keeps for a retired config key - so
// there the same answer becomes the exact replacement lines `fabrica
// doctor` prints for the Client to apply himself.
//
// Two safety rules it will not bend:
//
//   - **The default is the version that was there.** `ARG
//     RUBY_VERSION=3.4.8`, never a bare `ARG RUBY_VERSION`. A build that
//     passes no value - every installed Inspector until the `buildArgs`
//     half lands, and any hand `docker build` of the same file - then
//     produces exactly the image it produced before the conversion,
//     rather than resolving `FROM ruby:` into Docker's own "invalid
//     reference format".
//   - **Only a tag that is a version is touched.** A digest pin, a
//     moving tag (`latest`), a reference already carrying a variable:
//     `splitImageVersion` refuses all of them, so nothing here can
//     repoint an image whose version was never in its tag.

import { INSPECTOR_CONFIG } from "../inspector/index.ts";
import { BUILD_ARGS_KEY } from "./declared.ts";
import {
  argFormRef,
  buildArgEntry,
  familyOfImage,
  splitImageVersion,
  versionArgFor,
  type DeclaredBuildArgs,
  type ReadRepoFile,
  type VersionArgFor,
} from "./versions.ts";

/** One family's conversion: which argument, from which file, replacing
 * which `FROM` references. */
export interface VersionPinConversion {
  /** `RUBY_VERSION`. */
  arg: string;
  /** `ruby`. */
  label: string;
  /** The version the file names today - the value a build will pass. */
  declared: string;
  /** The version the `FROM` line hard-codes, which becomes the `ARG`'s
   * own default. */
  pinned: string;
  /** The repository-relative file the version now comes from. */
  file: string;
  /** The `ARG` line written above the first `FROM`. */
  argLine: string;
  /** Each `FROM` line that changes, before and after. */
  froms: { before: string; after: string }[];
  /** The `.inspector.json` entry this needs beside it. */
  entry: DeclaredBuildArgs;
}

/** What one `Dockerfile.inspector` needs doing to it, and why it needs
 * nothing where it needs nothing. */
export interface VersionPinPlan {
  /** Every family that can be converted, in the order its `FROM` lines
   * appear. Empty means nothing to do. */
  conversions: VersionPinConversion[];
  /** The file as it would stand afterwards - the input verbatim when
   * `conversions` is empty. */
  text: string;
  /** Everything that looked convertible and was not, each with the
   * reason, so a family left alone is never left alone silently. */
  skipped: { label: string; reason: string }[];
}

/** `FROM <ref>` with its flags and `AS <alias>`, as `machine-layer.ts`'s
 * own `stagesOf` reads one - matched here on a whole line so the line
 * can be rewritten with its spacing, its flags and its alias intact. */
const FROM_LINE = /^(\s*FROM\s+(?:--\S+\s+)*)(\S+)(.*)$/i;

/**
 * What converting this Dockerfile to the argument form would do.
 *
 * `read` is the repository's own files - a checkout on disk, or a
 * commit through git. A family whose version the repository declares
 * nowhere is left exactly as it is and is not reported as skipped:
 * there is nothing to follow, and a project that pins a version in no
 * file at all is not what this issue is about.
 *
 * A family whose own `FROM` lines disagree about the version (a
 * multi-stage file building on two different Rubies) is skipped and
 * said out loud: one argument cannot carry two versions, and picking
 * one of them would quietly move the other stage's image.
 */
export function planVersionPinConversion(dockerfile: string, read: ReadRepoFile): VersionPinPlan {
  const lines = dockerfile.split("\n");
  const found = new Map<string, { at: number; ref: string; found: VersionArgFor }[]>();

  lines.forEach((line, at) => {
    const match = FROM_LINE.exec(line);
    if (match === null) return;
    const ref = match[2];
    // Already in the argument form, or a reference whose version is not
    // in its tag: nothing to convert, and nothing to report either.
    const split = splitImageVersion(ref);
    if (split === null) return;
    const family = familyOfImage(split.image);
    if (family === null) return;
    const resolved = versionArgFor(ref, read);
    if (resolved === null) return;
    const list = found.get(family.arg) ?? [];
    list.push({ at, ref, found: resolved });
    found.set(family.arg, list);
  });

  const conversions: VersionPinConversion[] = [];
  const skipped: { label: string; reason: string }[] = [];
  const rewritten = [...lines];

  for (const [arg, uses] of found) {
    const label = uses[0].found.family.label;
    const versions = [...new Set(uses.map((use) => use.found.image.version))];
    if (versions.length > 1) {
      skipped.push({
        label,
        reason:
          `its FROM lines name ${versions.length} different ${label} versions (${versions.join(", ")}), and one ` +
          `${arg} cannot carry two - convert this file by hand, or give each stage its own argument`,
      });
      continue;
    }
    const declared = uses[0].found.declared;
    const froms: { before: string; after: string }[] = [];
    for (const use of uses) {
      const match = FROM_LINE.exec(lines[use.at]) as RegExpExecArray;
      const after = `${match[1]}${argFormRef(use.found)}${match[3]}`;
      rewritten[use.at] = after;
      froms.push({ before: lines[use.at], after });
    }
    conversions.push({
      arg,
      label,
      declared: declared.value,
      pinned: versions[0],
      file: declared.file,
      argLine: `ARG ${arg}=${versions[0]}`,
      froms,
      entry: buildArgEntry(uses[0].found),
    });
  }

  if (conversions.length === 0) return { conversions, text: dockerfile, skipped };

  // Every `ARG` goes above the first `FROM` in the file - the only place
  // a build argument a `FROM` reads may be declared (BuildKit's own
  // Dockerfile reference: "FROM instructions support variables that are
  // declared by any ARG instructions that occur before the first FROM").
  const first = rewritten.findIndex((line) => FROM_LINE.test(line));
  const header = [
    `# The versions below come from this repository's own files, so a bump there`,
    `# needs no edit here (fabrica, issue #355). Each default is the version this`,
    `# file named before it was converted, and is what a build that passes no`,
    `# value gets; ${INSPECTOR_CONFIG}'s ${BUILD_ARGS_KEY} names the file each one is`,
    `# read from, and both Inspector and Fabrica pass it.`,
    ...conversions.map((conversion) => conversion.argLine),
  ];
  rewritten.splice(first, 0, ...header);

  return { conversions, text: rewritten.join("\n"), skipped };
}

/** The one line `fabrica doctor` prints about a conversion it may not
 * make itself - the exact replacement, so the Client can apply it
 * without working anything out. */
export function replacementLinesFor(conversions: readonly VersionPinConversion[]): string {
  return conversions
    .map((conversion) => {
      const froms = conversion.froms.map((from) => `"${from.before.trim()}" -> "${from.after.trim()}"`).join(", ");
      return (
        `add "${conversion.argLine}" above the first FROM, change ${froms}, and add ` +
        `${JSON.stringify(conversion.entry)} to ${INSPECTOR_CONFIG}'s ${BUILD_ARGS_KEY}`
      );
    })
    .join("; ");
}

/** `.inspector.json`'s own text with every entry a plan needs merged
 * into its `buildArgs` key, pretty-printed the way `fabrica register`
 * writes that file (two spaces, trailing newline).
 *
 * An entry already there for the same name is replaced - the file this
 * is written beside has just had its `FROM` rewritten, so the two have
 * to agree. Null when the config cannot be parsed at all: a document
 * nothing here understands is one nothing here may rewrite, and the
 * caller reports that rather than replacing the Client's file with a
 * guess.
 */
export function configWithBuildArgs(configText: string, conversions: readonly VersionPinConversion[]): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(configText);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const document = parsed as Record<string, unknown>;
  const existing = document[BUILD_ARGS_KEY];
  const buildArgs: Record<string, unknown> =
    typeof existing === "object" && existing !== null && !Array.isArray(existing)
      ? { ...(existing as Record<string, unknown>) }
      : {};
  for (const conversion of conversions) {
    for (const [name, source] of Object.entries(conversion.entry)) buildArgs[name] = source;
  }
  return `${JSON.stringify({ ...document, [BUILD_ARGS_KEY]: buildArgs }, null, 2)}\n`;
}
