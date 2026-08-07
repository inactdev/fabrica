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
import { assertSafeId, describeGitError, requireRepoRoot } from "./safety.ts";

/** True if a branch `fabrica/<taskId>` already exists in `project` - i.e.
 * createProductionLine already ran once for this task, whether or not
 * that run ever delivered. Never throws (matches safety.ts's
 * isKnownWorktree's style); lets a caller choose createProductionLine vs
 * reopenProductionLine by what git actually has on record, rather than
 * by tracking "is this a first attempt or a retry" as separate state
 * that could drift from reality. issue #8's answer.ts uses this so a
 * resumed round that threw before ever delivering (a missing check
 * command, a moved project path, an unreachable brain) can be retried
 * instead of failing forever on "a branch named ... already exists". */
export function productionLineBranchExists(project: string, taskId: string): boolean {
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
