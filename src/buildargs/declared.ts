// What a project's own `.inspector.json` says its image builds read out
// of the repository (issue #355) - the `buildArgs` key `fabrica
// register` writes, read back.
//
// Read from the folder holding that file, which is the terms folder for
// a work-mode project and the repository root for every other one - the
// same `(dir, revision?)` shape `declaredBuildSecrets` has, and the same
// forgiveness: a config that will not parse, or that carries no
// `buildArgs` key, reads as "no build arguments" rather than as an
// error. An unparseable `.inspector.json` is Inspector's own refusal to
// make, and `src/inspector/config-check.ts` already names it on every
// round.
//
// Unlike a build secret, nothing here is a credential: the values are
// version numbers out of files the repository commits, they ride on a
// `docker build` argv, and they are readable in the built image's own
// history. So there is no pinning-to-a-base-commit argument of the kind
// `declaredBuildSecrets` makes - `revision` is here because the
// in-repository config is still a file a Worker's worktree holds a copy
// of, and reading a round's answer at the commit the task was cut from
// keeps what the Client committed the thing that decides.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { INSPECTOR_CONFIG } from "../inspector/index.ts";
import type { BuildArgSource, DeclaredBuildArgs } from "./versions.ts";

/** The key `.inspector.json` carries them under - Inspector's own
 * (task 1 of issue #355's pair), spelled once here and used by the
 * writer (`src/register/scaffold.ts`) and every reader alike. */
export const BUILD_ARGS_KEY = "buildArgs";

/** A build argument's name, as Docker and Inspector both accept one:
 * letters, digits and underscores, never starting with a digit. A name
 * outside that is left out rather than passed - it could not be an
 * `ARG` in any Dockerfile, so nothing could consume it. */
const ARG_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function configText(dir: string, revision?: string): string {
  if (revision === undefined) return readFileSync(join(dir, INSPECTOR_CONFIG), "utf8");
  return execFileSync("git", ["show", `${revision}:${INSPECTOR_CONFIG}`], {
    cwd: dir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/**
 * The build arguments `<dir>/.inspector.json` declares, as
 * `{ NAME: { file, pattern? } }` - empty when it declares none.
 *
 * Only well-formed entries are returned: a usable name, a non-empty
 * `file` string, and a `pattern` only when it is a non-empty string.
 * Anything else is dropped here rather than turned into a build
 * argument nothing could resolve - and `fabrica doctor`'s own line
 * reports the file's declarations against the Dockerfile, so a
 * malformed entry shows up as the argument that is missing.
 */
export function declaredBuildArgs(dir: string, revision?: string): DeclaredBuildArgs {
  let parsed: unknown;
  try {
    parsed = JSON.parse(configText(dir, revision));
  } catch {
    return {};
  }
  return buildArgsIn(parsed);
}

/** The same reading of an already-parsed document - what a caller that
 * holds the config's text (a proposal, a test) uses. */
export function buildArgsIn(parsed: unknown): DeclaredBuildArgs {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
  const declared = (parsed as Record<string, unknown>)[BUILD_ARGS_KEY];
  if (typeof declared !== "object" || declared === null || Array.isArray(declared)) return {};

  const found: DeclaredBuildArgs = {};
  for (const [name, value] of Object.entries(declared as Record<string, unknown>)) {
    if (!ARG_NAME.test(name)) continue;
    const source = sourceIn(value);
    if (source !== null) found[name] = source;
  }
  return found;
}

function sourceIn(value: unknown): BuildArgSource | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const { file, pattern } = value as { file?: unknown; pattern?: unknown };
  if (typeof file !== "string" || file.trim().length === 0) return null;
  if (pattern !== undefined && (typeof pattern !== "string" || pattern.length === 0)) {
    return { file: file.trim() };
  }
  return pattern === undefined ? { file: file.trim() } : { file: file.trim(), pattern };
}
