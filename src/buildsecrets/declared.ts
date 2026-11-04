// What a project's own `.inspector.json` says its image build needs
// (issue #342) - the list `fabrica register` derived, read back.
//
// Read from the folder holding that file, which is the terms folder for
// a work-mode project and the repository root for every other one. The
// caller resolves which (`projectTermsOrRoot` in `resolve.ts`), because
// that is a question about this project's registration and not about
// this file.
//
// Deliberately forgiving about everything except the shape of the list
// itself: a config that will not parse, or that has no `buildSecrets`
// key, reads as "no build secrets" rather than as an error. An
// unparseable `.inspector.json` is Inspector's own refusal to make and
// `src/inspector/config-check.ts` already names it on every round - the
// same rule `declaresTestPaths` follows for the same file.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { INSPECTOR_CONFIG } from "../inspector/index.ts";

/** The key `.inspector.json` carries them under - Inspector's own
 * (inspector#86), spelled once here and used by the writer
 * (`src/register/scaffold.ts`) and this reader alike. */
export const BUILD_SECRETS_KEY = "buildSecrets";

/**
 * The config's text: out of `revision`'s tree when one is named, out of
 * the working tree when none is.
 *
 * A revision is how the in-repository case stays safe, and it is not
 * optional there - see `declaredBuildSecrets`.
 */
function configText(dir: string, revision?: string): string {
  if (revision === undefined) return readFileSync(join(dir, INSPECTOR_CONFIG), "utf8");
  return execFileSync("git", ["show", `${revision}:${INSPECTOR_CONFIG}`], {
    cwd: dir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/**
 * The variable names `<dir>/.inspector.json` lists, or an empty list
 * when it lists none.
 *
 * `revision` names the commit to read it at, and a round **must** pass
 * one for a config that lives in the repository: the list decides which
 * of `brain.env`'s variables are handed to an image build, and the
 * worktree's copy of that file is one a Worker has had its hands on. A
 * Worker that could add a name to it could name any credential in that
 * file and have it mounted into a build whose `Dockerfile.inspector` -
 * also in its reach - it had just written. Read at the task's base
 * commit, the list is one the Client committed himself. This is the
 * same pinning, for the same reason, that `declaresTestPaths` does for
 * "who reviews this work" (`src/inspector/run.ts`).
 *
 * A terms folder needs no revision and has none to give: it is outside
 * the repository and is never mounted into a worker's box, so there is
 * nothing there for a Worker to change.
 *
 * Only entries that are non-empty strings are returned, and duplicates
 * are dropped: the list is used to build a `docker build` argv and to
 * look names up in `brain.env`, and neither has any use for a blank
 * entry. A name Inspector itself would refuse (anything but letters,
 * digits and underscores) is still returned, because this reads what the
 * file says rather than judging it - `resolveBuildSecrets` reports such
 * a name instead of quietly leaving it out.
 */
export function declaredBuildSecrets(dir: string, revision?: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(configText(dir, revision));
  } catch {
    return [];
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return [];
  const listed = (parsed as Record<string, unknown>)[BUILD_SECRETS_KEY];
  if (!Array.isArray(listed)) return [];
  const names: string[] = [];
  for (const entry of listed) {
    if (typeof entry !== "string") continue;
    const name = entry.trim();
    if (name.length > 0 && !names.includes(name)) names.push(name);
  }
  return names;
}
