// Reopens a ProductionLine for a task that already ran once: a fresh
// worktree at the same `<recordHome>/tasks/<taskId>/worktree` path,
// checked out onto the SAME `fabrica/<taskId>` branch createProductionLine
// made — rather than a new branch off the project's current HEAD. This is
// what CONTRACT rule 6's "fix" verdict needs: a warm worker's resumable
// session is scoped to the `cwd` it was created in (see the reference
// adapter's own docs under src/brain/adapters/), so re-entering "the same
// warm worker" only works if the workdir path is identical to the one
// that session was born in, and the branch already carries whatever the
// first round committed.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { LineError } from "./errors.ts";
import type { ProductionLine } from "../../contract/surface.ts";
import {
  assertSafeId,
  describeGitError,
  listWorktrees,
  realpathIfPresent,
  requireRepoRoot,
} from "./safety.ts";
import type { WorktreeEntry } from "./safety.ts";

/** True if a branch `fabrica/<taskId>` already exists in `project`. Never
 * throws (matches safety.ts's isKnownWorktree's style). This is the
 * `refs/heads/` check reopenProductionLine uses below to refuse
 * `no-such-branch`, and nothing else - module-private on purpose, not
 * exported from src/line's barrel.
 *
 * **Not** what decides createProductionLine vs. reopenProductionLine for
 * a resumed task (Client ruling, issue #8): src/foreman/do.ts's
 * runProductionRound takes an explicit `isRetry` its caller derives from
 * the record, never from git state, because a taskId is only unique
 * within one record home - a same-named branch from another record home
 * or a hand-made one would otherwise be silently adopted on a task's
 * actual first round. Keeping this unexported is part of that ruling:
 * the rejected signal shouldn't be one import away. See
 * src/line/README.md for the full reasoning. */
function productionLineBranchExists(project: string, taskId: string): boolean {
  try {
    execFileSync("git", ["show-ref", "--verify", "--quiet", `refs/heads/fabrica/${taskId}`], {
      cwd: project,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return true;
  } catch {
    return false;
  }
}

/** The worktree of `project` that currently has `branch` checked out, or
 * null if no worktree does. `isProjectCheckout` tells the Client's own
 * checkout (git's main worktree, always the first entry `listWorktrees`
 * reports) apart from any other linked worktree - told from that
 * position, never from comparing paths, so the macOS `/var` ->
 * `/private/var` symlink can't make the two look different.
 *
 * Never throws: an unreadable worktree list returns null and lets
 * `git worktree add` produce its own `cut-failed` as before. This check
 * only ever improves a message, so it must never be the reason a reopen
 * fails. */
function worktreeHoldingBranch(
  project: string,
  branch: string
): { path: string; isProjectCheckout: boolean } | null {
  let entries: WorktreeEntry[];
  try {
    entries = listWorktrees(project);
  } catch {
    return null;
  }

  const index = entries.findIndex((entry) => entry.branch === branch);
  if (index === -1) return null;
  return { path: realpathIfPresent(entries[index].path), isProjectCheckout: index === 0 };
}

export function reopenProductionLine(opts: { project: string; taskId: string; recordHome: string }): ProductionLine {
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
      `A ProductionLine workspace already exists at ${workdir}. Refusing to reuse or overwrite it.`
    );
  }

  const branch = `fabrica/${opts.taskId}`;
  // refs/heads/ specifically, not any ref that resolves under this name:
  // a tag called `fabrica/<taskId>` would resolve, and `git worktree add`
  // would then check it out at a detached HEAD, so the fix round's
  // commits would land on nothing and be silently orphaned at teardown.
  // productionLineBranchExists checks exactly that ref form.
  if (!productionLineBranchExists(project, opts.taskId)) {
    throw new LineError(
      "no-such-branch",
      `Cannot reopen a ProductionLine for ${branch}: no local branch of that name exists in ${project}. ` +
        `A line can only be reopened for a task that already ran once with createProductionLine.`
    );
  }

  // git will not check one branch out in two places, so a project folder
  // sitting on this very branch - the Client having run `git checkout
  // fabrica/<taskId>` to read what a Worker did is the ordinary way it
  // happens - makes the reopen below fail. Said here, from git's own
  // worktree list, before anything is created: git's own refusal names
  // neither the Client's checkout as the thing in the way nor what to do
  // about it, and its wording is version-dependent besides ("already
  // used by worktree at" on git 2.54, "already checked out at" on older
  // ones), so matching that text instead would quietly stop working.
  const holder = worktreeHoldingBranch(project, branch);
  if (holder !== null) {
    throw new LineError(
      "branch-checked-out",
      holder.isProjectCheckout
        ? `Cannot reopen a ProductionLine for ${branch}: the project's own checkout at ${project} is on ` +
            `that branch right now, and git cannot check one branch out in two places. Switch that ` +
            `checkout to another branch and try again.`
        : `Cannot reopen a ProductionLine for ${branch}: another worktree of ${project} has that branch ` +
            `checked out, at ${holder.path}, and git cannot check one branch out in two places. Remove ` +
            `that worktree or switch it to another branch, then try again.`
    );
  }

  mkdirSync(join(recordHome, "tasks", opts.taskId), { recursive: true });

  try {
    execFileSync("git", ["worktree", "add", workdir, branch], {
      cwd: project,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    throw new LineError(
      "cut-failed",
      `Could not reopen the ProductionLine for ${branch} from ${project}: ${describeGitError(err)}`
    );
  }

  return { taskId: opts.taskId, branch, project, workdir, recordHome };
}
