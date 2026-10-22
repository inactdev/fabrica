// A throwaway, read-of-master checkout: a detached-HEAD git worktree of
// the project at origin's current default branch, for work that needs to
// look at the code as it stands today and has nothing to deliver.
//
// This is NOT a ProductionLine and is deliberately not called one. A
// ProductionLine is one task's lane: it carries a `fabrica/<taskId>`
// branch, lives under `recordHome/tasks/<taskId>/`, and teardown leaves
// its branch behind on purpose for the Client and Inspector. All three
// are wrong for a check that only reads: a branch per run would litter
// the Client's repository, and a folder under `tasks/` would be listed as
// a task by everything that discovers tasks by reading that directory
// (`fabrica status`, the live view) - the phantom-task problem issue #81
// had to go and fix once already.
//
// What it does share is every safety rule src/line already proves:
// the project must be a repository root, the base comes from origin and
// never from the local checkout, and nothing is ever removed without git
// itself confirming the exact path is a linked worktree of that project
// (see safety.ts - this module adds no new way to delete anything).

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { LineError } from "./errors.ts";
import { fetchOriginDefaultBranch } from "./cut.ts";
import { assertSafeId, describeGitError, isKnownWorktree, requireLinkedWorktree, requireRepoRoot } from "./safety.ts";
import type { TeardownResult } from "./teardown.ts";

/** A live scratch checkout. `label` names what it is for and is the one
 * path segment it occupies - held to the same inert-id rule a task id is,
 * since it becomes a directory name. */
export interface ScratchCheckout {
  label: string;
  /** Resolved root of the Client's own checkout. Never written to. */
  project: string;
  /** The throwaway worktree, at `recordHome/scratch/<label>/worktree`. */
  workdir: string;
  recordHome: string;
  /** The ref it was cut from, e.g. "origin/master". */
  base: string;
  /** The commit that ref pointed at - what "current master" means for
   * this run, recorded so an answer derived here can name it. */
  baseCommit: string;
}

/** Where a given label's scratch checkout lives. The one place that path
 * is spelled out: both halves below compare against it rather than
 * trusting a path they were handed. */
export function scratchWorkdirPath(recordHome: string, label: string): string {
  return join(recordHome, "scratch", label, "worktree");
}

/**
 * Creates a detached-HEAD worktree of `project` at origin's current
 * default branch. Fetches origin first and refuses loudly rather than
 * falling back to the local checkout, exactly as `createProductionLine`
 * does - "against current master" has to mean the remote's master, not
 * whatever this machine last pulled.
 *
 * A leftover worktree at the same path - a previous run killed mid-flight -
 * is removed first, through the same git-confirmed path check teardown
 * uses, so one crashed run does not block the next forever. A path that
 * exists but is not a registered worktree of this project is refused
 * instead: that is not something this module put there.
 */
export function createScratchCheckout(opts: { project: string; recordHome: string; label: string }): ScratchCheckout {
  assertSafeId(opts.label);
  const project = requireRepoRoot(opts.project);

  let recordHome: string;
  try {
    recordHome = realpathSync(opts.recordHome);
  } catch {
    throw new LineError("home-not-found", `Record home ${opts.recordHome} does not exist.`);
  }

  const workdir = scratchWorkdirPath(recordHome, opts.label);
  if (existsSync(workdir) || isKnownWorktree(project, workdir)) {
    destroyScratchCheckout({ label: opts.label, project, workdir, recordHome, base: "", baseCommit: "" });
  }

  const base = `origin/${fetchOriginDefaultBranch(project)}`;
  mkdirSync(join(recordHome, "scratch", opts.label), { recursive: true });

  try {
    // --detach: no branch at all, so nothing is left in the project's
    // refs afterwards and two runs can never contend over one name.
    execFileSync("git", ["worktree", "add", "--detach", workdir, base], {
      cwd: project,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    throw new LineError(
      "cut-failed",
      `Could not create a scratch checkout of ${base} from ${project}: ${describeGitError(err)}`
    );
  }

  let baseCommit: string;
  try {
    baseCommit = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: workdir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (err) {
    throw new LineError(
      "cut-failed",
      `Could not read the commit of the scratch checkout at ${workdir}: ${describeGitError(err)}`
    );
  }

  return { label: opts.label, project, workdir, recordHome, base, baseCommit };
}

/**
 * Removes a scratch checkout. Idempotent in the same sense
 * `destroyProductionLine` is - a path that is already gone, on disk and
 * from git's registry, is `already-destroyed` rather than an error - and
 * refuses on the same two grounds: a workdir that is not exactly where
 * this label's checkout belongs, and one git does not register as a
 * linked worktree of the project.
 */
export function destroyScratchCheckout(checkout: ScratchCheckout): TeardownResult {
  const expected = scratchWorkdirPath(checkout.recordHome, checkout.label);
  if (checkout.workdir !== expected) {
    throw new LineError(
      "unsafe-teardown",
      `Refusing to remove ${checkout.workdir}: it does not match the expected scratch path ${expected} ` +
        `for "${checkout.label}".`
    );
  }

  let project: string;
  try {
    project = realpathSync(checkout.project);
  } catch {
    throw new LineError(
      "unsafe-teardown",
      `Refusing to remove ${checkout.workdir}: project path ${checkout.project} does not exist.`
    );
  }

  if (!existsSync(checkout.workdir) && !isKnownWorktree(project, checkout.workdir)) {
    return { status: "already-destroyed" };
  }

  const entry = requireLinkedWorktree(project, checkout.workdir);
  try {
    execFileSync("git", ["worktree", "remove", "--force", entry.path], {
      cwd: project,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    throw new LineError(
      "teardown-failed",
      `Could not remove the scratch checkout at ${entry.path}: ${describeGitError(err)}`
    );
  }
  return { status: "destroyed" };
}
