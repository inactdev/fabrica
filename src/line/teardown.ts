// Destroys a ProductionLine: removes the throwaway worktree, keeps the
// branch intact for the Client to review (SPEC: v1 never pushes; the
// Client merges or discards by hand). Every removal is gated on git's own
// worktree registry (see safety.ts) — a path is never deleted on say-so
// alone, and `git worktree remove` itself refuses to touch a repo's main
// working tree, so a bug here fails closed, not open.

import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { LineError } from "./errors.ts";
import type { ProductionLine } from "../../contract/surface.ts";
import { describeGitError, isKnownWorktree, requireLinkedWorktree } from "./safety.ts";

/** What actually happened. `already-destroyed` is the idempotent case
 * (issue #7): a correctly-addressed line whose worktree is already gone —
 * a second call in a cleanup path, or one removed out of band — is not an
 * error, just nothing left to do. */
export interface TeardownResult {
  status: "destroyed" | "already-destroyed";
}

export function destroyProductionLine(line: ProductionLine): TeardownResult {
  const expected = join(line.recordHome, "tasks", line.taskId, "worktree");
  if (line.workdir !== expected) {
    throw new LineError(
      "unsafe-teardown",
      `Refusing to destroy ${line.workdir}: it does not match the expected ` +
        `ProductionLine path ${expected} for task ${line.taskId}.`
    );
  }

  let project: string;
  try {
    project = realpathSync(line.project);
  } catch {
    throw new LineError(
      "unsafe-teardown",
      `Refusing to destroy ${line.workdir}: project path ${line.project} does not exist.`
    );
  }

  // The path is exactly where this task's line should be (checked above),
  // but nothing is there anymore — on disk or in git's own worktree
  // registry. That is what a prior successful teardown, or an out-of-band
  // `git worktree remove`, leaves behind. A path that still exists on disk
  // but isn't a registered worktree is a different, genuinely unsafe case
  // and falls through to requireLinkedWorktree's refusal below.
  if (!existsSync(line.workdir) && !isKnownWorktree(project, line.workdir)) {
    return { status: "already-destroyed" };
  }

  const entry = requireLinkedWorktree(project, line.workdir);

  try {
    execFileSync("git", ["worktree", "remove", "--force", entry.path], {
      cwd: project,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    throw new LineError(
      "teardown-failed",
      `Could not destroy ProductionLine ${line.branch}: ${describeGitError(err)}`
    );
  }

  return { status: "destroyed" };
}
