// Resolves `--project <path-or-name>` (SPEC.md `fabrica do`) to an
// absolute filesystem path, the shape `doTask` actually wants.
// foreman/README.md: the "-or-name" half is explicitly a CLI-layer
// concern nothing else does - this is that concern's whole job, and
// nothing more: it does not check for a check command against a
// worktree (that stays doTask's job, run once the task is registered)
// and it does not create anything.

import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { requireProject } from "../index.ts";
import type { FabricaConfig } from "../index.ts";
import { CliError } from "./errors.ts";

/**
 * A registered name wins outright: `requireProject` resolves it to that
 * project's configured path, or refuses with exact instructions if the
 * name is registered but has no check command yet (CONTRACT rule 2).
 * Anything else is treated as a literal path, resolved against `cwd`
 * and required to exist as a directory - `doTask` (via
 * `createProductionLine`) is what actually proves it's a usable git
 * checkout; this only rules out a plain typo before a task ever gets
 * registered against it.
 */
export function resolveProjectPath(
  config: FabricaConfig,
  projectArg: string,
  cwd: string = process.cwd()
): string {
  if (Object.hasOwn(config.projects, projectArg)) {
    return requireProject(config, projectArg).path;
  }

  const candidate = resolve(cwd, projectArg);
  if (!existsSync(candidate) || !statSync(candidate).isDirectory()) {
    throw new CliError(
      "project-not-found",
      `fabrica do: "${projectArg}" is not a registered project and not a directory ` +
        `(looked for ${candidate}). Pass the path to an existing project, or register ` +
        `it first by adding this to projects.toml:\n\n` +
        `  [projects.<name>]\n` +
        `  path = "${candidate}"\n` +
        `  check = "<the one command that must pass>"\n`
    );
  }
  return candidate;
}
