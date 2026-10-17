// Creates a fresh ProductionLine: a disposable git worktree of the project
// on a new branch `fabrica/<taskId>` (CONTRACT rule 1). `git worktree add`
// only ever reads the Client's checkout and records the new worktree in
// the project's own .git metadata — it never writes into the Client's
// working files, so the checkout stays untouched by construction.
//
// A new task's branch is cut from origin's default branch, never from
// whatever the Client's local checkout happens to have checked out - two
// people (or two tasks) working from the same clone must never get a
// ProductionLine forked from a HEAD that depends on which of them ran
// `git checkout` last. `fetchOriginBase` below fetches origin and reads
// its default branch straight from the remote (never assumed to be
// "master"), and refuses loudly - never falling back to the local
// checkout - when either step fails.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { LineError } from "./errors.ts";
import type { ProductionLine } from "../../contract/surface.ts";
import { assertSafeId, describeGitError, requireRepoRoot } from "./safety.ts";

/** Fetches `origin` and resolves its default branch by reading the
 * remote's own HEAD symref (`git ls-remote --symref`) - never assumed to
 * be "master". Returns the bare branch name (e.g. "main"); the caller
 * makes `origin/<branch>` of it. Throws `LineError("fetch-failed")`,
 * never silently falling back to the project's local checkout, when the
 * fetch fails, "origin" doesn't exist, or the remote's HEAD symref can't
 * be read.
 *
 * Exported because this is the one place that answers "which branch does
 * a task's base commit come from" - `fabrica register` and `fabrica do`'s
 * own up-front "is this project set up" check (src/register/) need the
 * same answer, and deriving it a second time is how the two sides come to
 * disagree about what a task's base commit actually is. */
export function fetchOriginDefaultBranch(project: string): string {
  try {
    execFileSync("git", ["fetch", "origin"], {
      cwd: project,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    throw new LineError(
      "fetch-failed",
      `Could not fetch origin for ${project}: ${describeGitError(err)}. ` +
        `Refusing to start a task from the local checkout instead.`
    );
  }

  let symref: string;
  try {
    symref = execFileSync("git", ["ls-remote", "--symref", "origin", "HEAD"], {
      cwd: project,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    throw new LineError(
      "fetch-failed",
      `Could not read origin's default branch for ${project}: ${describeGitError(err)}. ` +
        `Refusing to start a task from the local checkout instead.`
    );
  }

  const match = symref.match(/^ref:\s+refs\/heads\/(\S+)\s+HEAD/m);
  if (!match) {
    throw new LineError(
      "fetch-failed",
      `Could not determine origin's default branch for ${project}: ` +
        `"git ls-remote --symref origin HEAD" named none. Refusing to start a task from the local checkout instead.`
    );
  }

  return match[1];
}

export function createProductionLine(opts: { project: string; taskId: string; recordHome: string }): ProductionLine {
  assertSafeId(opts.taskId);
  const project = requireRepoRoot(opts.project);

  let recordHome: string;
  try {
    recordHome = realpathSync(opts.recordHome);
  } catch {
    throw new LineError("home-not-found", `Record home ${opts.recordHome} does not exist.`);
  }

  const workdir = join(recordHome, "tasks", opts.taskId, "worktree");
  if (existsSync(workdir)) {
    throw new LineError(
      "workdir-exists",
      `A ProductionLine workspace already exists at ${workdir}. Refusing to ` +
        `reuse or overwrite it — task ids must be unique.`
    );
  }

  // Before creating the task's working folder at all: fetch origin and
  // resolve its default branch, so a failed fetch starts nothing rather
  // than silently cutting from the local checkout.
  const base = `origin/${fetchOriginDefaultBranch(project)}`;

  mkdirSync(join(recordHome, "tasks", opts.taskId), { recursive: true });

  const branch = `fabrica/${opts.taskId}`;
  try {
    // --no-track: `base` is a remote-tracking ref (origin/<default>), and
    // without it `git worktree add` sets up branch-tracking configuration
    // for the new throwaway branch — a write to the project's *shared*
    // `.git/config` that two concurrent creates from the same project can
    // collide over (a config-file lock), and tracking origin's default
    // branch makes no sense for a one-off task branch anyway.
    execFileSync("git", ["worktree", "add", "--no-track", "-b", branch, workdir, base], {
      cwd: project,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    throw new LineError(
      "cut-failed",
      `Could not create a ProductionLine for ${branch} from ${project}: ${describeGitError(err)}`
    );
  }

  return { taskId: opts.taskId, branch, project, workdir, recordHome };
}
