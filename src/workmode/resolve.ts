// What "work mode" means for one project (issue #316).
//
// The case this exists for: a company repository nothing of ours may be
// added to, and whose CI nothing of ours may touch. Inspector's three
// files (`.inspector.json`, the check script, `Dockerfile.inspector`)
// therefore cannot be committed there, and its commit status must not be
// posted. Both are said once, in projects.toml:
//
//   [projects.dayjob]
//   path                = "~/work/widgets"
//   terms               = "~/fabrica-terms/widgets"
//   noStamp             = true
//   pullRequestTemplate = true
//
// This module answers which of those three a project carries, and
// nothing else - what each one then changes is the business of whoever
// reads it (the round's own `judge.ts`, `fabrica do`'s up-front refusal,
// `fabrica doctor`'s per-project line, the publishing token's scope).
// One answer with several readers, the same shape `src/projecttoken/`
// has for issue #314's credential question, and for the same reason:
// what the Client is told up front and what a round actually does must
// never be two different answers.
//
// Three things are deliberately NOT here:
//
// 1. **Whether the terms folder can be used.** That is a question about
//    the disk, asked where a round can refuse on it
//    (`src/inspector/terms.ts`), not about the registry.
// 2. **Any writing.** The terms folder is read-only to Fabrica: nothing
//    here or downstream of it creates, edits or scaffolds anything in
//    it, and `fabrica register` - which does write a project's three
//    files - knows nothing about this setting (a project being
//    registered has no entry to read one from).
// 3. **A global default.** Unlike `[reviewer]`/`[reader]`, there is no
//    table to fall back to: a terms folder holds one project's terms, so
//    "every project's terms folder" is not a thing that could exist.

import { realpathSync } from "node:fs";
import { ConfigError, loadConfig } from "../config/index.ts";
import type { FabricaConfig } from "../config/index.ts";

/** What one project's registry entry says about work mode. Every field
 * has a plain default, so a project with no entry at all - a contract
 * test's fixture, an unregistered path - reads as "none of this", which
 * is today's behaviour exactly. */
export interface WorkMode {
  /** The folder holding this project's terms, absolute (the loader
   * resolves it), or undefined when its terms are committed in the
   * repository itself like every other project's. */
  terms?: string;
  /** True when Inspector must post no commit status for this project. */
  noStamp: boolean;
  /** True when the repository's own `.github/PULL_REQUEST_TEMPLATE.md`
   * is the shape of the pull request body. */
  pullRequestTemplate: boolean;
}

/** Work mode off: what every project that says nothing gets. */
export const NO_WORK_MODE: WorkMode = { noStamp: false, pullRequestTemplate: false };

/**
 * This project's work-mode settings, read off a config the caller
 * already holds.
 *
 * Matched by resolved path for the same reason `projectTokenVarFor`,
 * `readerFor` and `reviewerFor` are: projects.toml's loader only expands
 * a leading `~`, so without realpath on both sides a symlinked temp dir
 * (macOS's /var -> /private/var) makes one registration look like two.
 */
export function workModeFor(config: FabricaConfig, projectPath: string): WorkMode {
  const resolved = realpath(projectPath);
  const registered = Object.values(config.projects).find((project) => realpath(project.path) === resolved);
  if (registered === undefined) return { ...NO_WORK_MODE };
  return {
    ...(registered.terms === undefined ? {} : { terms: registered.terms }),
    noStamp: registered.noStamp ?? false,
    pullRequestTemplate: registered.pullRequestTemplate ?? false,
  };
}

/**
 * The same answer for a caller that holds only the record home - a
 * round's own `prepareRound`, the publishing token's scope.
 *
 * A record home with no projects.toml has no projects and so no work
 * mode, exactly as `resolveCheckCommand` treats it. Any other
 * malformed-config error is rethrown rather than read as "work mode
 * off": a project whose terms live outside its repository cannot be
 * worked at all without that setting, so guessing it away would turn a
 * typo in projects.toml into a round that quietly looks for files the
 * repository does not have.
 */
export function projectWorkMode(recordHome: string, projectPath: string): WorkMode {
  let config: FabricaConfig;
  try {
    config = loadConfig(recordHome);
  } catch (err) {
    if (err instanceof ConfigError && err.code === "not-found") return { ...NO_WORK_MODE };
    throw err;
  }
  return workModeFor(config, projectPath);
}

function realpath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}
