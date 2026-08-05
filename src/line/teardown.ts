// Destroys a ProductionLine: removes the throwaway worktree, keeps the
// branch intact for the Client to review (SPEC: v1 never pushes; the
// Client merges or discards by hand). Every removal is gated on git's own
// worktree registry (see safety.ts) — a path is never deleted on say-so
// alone, and `git worktree remove` itself refuses to touch a repo's main
// working tree, so a bug here fails closed, not open.

import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { LineError } from "./errors.ts";
import type { ProductionLine } from "./types.ts";
import { describeGitError, requireLinkedWorktree } from "./safety.ts";

export function destroyProductionLine(line: ProductionLine): void {
  const expected = join(line.recordHome, "tasks", line.taskId, "worktree");
  if (line.workdir !== expected) {
    throw new LineError(
      "unsafe-teardown",
      `Refusing to tear down ${line.workdir}: it does not match the expected ` +
        `ProductionLine path ${expected} for task ${line.taskId}.`
    );
  }

  let project: string;
  try {
    project = realpathSync(line.project);
  } catch {
    throw new LineError(
      "unsafe-teardown",
      `Refusing to tear down ${line.workdir}: project path ${line.project} does not exist.`
    );
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
}
