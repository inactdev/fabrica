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
  try {
    execFileSync("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], {
      cwd: project,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
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
