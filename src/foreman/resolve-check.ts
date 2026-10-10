// Resolves which check command a ProductionLine should run — the one
// place src/config actually participates in the loop (SPEC.md "Config").

import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { ConfigError, loadConfig } from "../config/index.ts";
import { ForemanError } from "./errors.ts";

export const DEFAULT_CHECK_COMMAND = "./check.sh";

/** Throws ForemanError("missing-check") when the default convention would
 * apply but there's no check.sh to run — rule 2 allows no path around the
 * gate, so `do()` refuses before any worker runs, when there is nothing
 * yet to verify with, rather than after. A configured check command (from
 * projects.toml) is trusted as-is; it need not be a file at all. Only the
 * self-tested path needs this: with Inspector, Fabrica runs no check. */
export function requireCheckCommand(workdir: string, check: string): void {
  if (check === DEFAULT_CHECK_COMMAND && !existsSync(join(workdir, "check.sh"))) {
    throw new ForemanError(
      "missing-check",
      `${workdir} has no check.sh. No check command, no verified work, no ` +
        `exceptions. Add an executable check.sh at the project's root, or ` +
        `register this project in projects.toml with a check command.`
    );
  }
}

/**
 * If `projects.toml` at `recordHome` registers a project whose `path`
 * resolves to this exact `projectPath`, that project's configured `check`
 * wins — SPEC.md: "the ONE command that must pass for green." Otherwise
 * (no projects.toml at all, or no registration matching this path) falls
 * back to the v1 default convention, `./check.sh` at the project's root.
 *
 * The fallback is what every contract test's fixture repo relies on: a
 * bare path with nothing registered for it. A Client who registers a
 * project gets their own command honored the moment `path` matches;
 * nothing else about how `do()` runs has to change for that to work.
 *
 * `projectPath` is always realpath'd by the time it reaches here (it's
 * `line.project`, which createProductionLine resolves) — a registered
 * `path` is compared the same way, since projects.toml's loader only
 * expands a leading `~`, it doesn't resolve symlinks. On macOS in
 * particular, tmpdir() sits behind a /var -> /private/var symlink, so an
 * unresolved and a resolved path to the same directory look different
 * unless both sides go through realpath first.
 */
export function resolveCheckCommand(recordHome: string, projectPath: string): string {
  let config;
  try {
    config = loadConfig(recordHome);
  } catch (err) {
    if (err instanceof ConfigError && err.code === "not-found") return DEFAULT_CHECK_COMMAND;
    throw err;
  }

  const registered = Object.values(config.projects).find((p) => realpath(p.path) === projectPath);
  return registered?.check ?? DEFAULT_CHECK_COMMAND;
}

function realpath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}
