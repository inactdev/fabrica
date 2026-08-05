// Resolves a ProductionLine workdir's real git directory - the shared
// object database and refs every worktree points back to - straight
// from the worktree's own `.git` pointer file, without needing the
// `ProductionLine` object itself (only `workdir`, which is all a `Brain`
// adapter's `work(brief, workdir, opts)` ever receives - contract/
// surface.ts's `Brain` interface has no room to also pass `project` or
// `taskId` through).
//
// `git worktree add` always leaves `<workdir>/.git` as a one-line
// pointer file, `gitdir: <project>/.git/worktrees/<taskId>` - a real,
// absolute host path outside `workdir` entirely. That file's own
// `commondir` (relative to it) names the actual shared `.git` - the
// object database, refs, and config every worktree of the same project
// shares. This is what a contained process needs mounted (read-only) to
// use git at all; see src/containment/README.md and this project's
// AGENTS.md for why.

import { readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { LineError } from "./errors.ts";

export function resolveCommonGitDir(workdir: string): string {
  const pointerPath = join(workdir, ".git");
  let pointer: string;
  try {
    pointer = readFileSync(pointerPath, "utf8").trim();
  } catch (err) {
    throw new LineError(
      "not-a-worktree",
      `"${pointerPath}" could not be read - is ${workdir} a ProductionLine worktree? ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }

  const match = pointer.match(/^gitdir: (.+)$/);
  if (!match) {
    throw new LineError(
      "not-a-worktree",
      `"${pointerPath}" is not a git worktree pointer file (expected "gitdir: <path>", found "${pointer}")`
    );
  }
  const worktreeGitDir = match[1];

  let commondir: string;
  try {
    commondir = readFileSync(join(worktreeGitDir, "commondir"), "utf8").trim();
  } catch (err) {
    throw new LineError(
      "not-a-worktree",
      `"${worktreeGitDir}/commondir" could not be read: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  const commonGitDir = resolve(worktreeGitDir, commondir);
  try {
    return realpathSync(commonGitDir);
  } catch (err) {
    throw new LineError(
      "not-a-worktree",
      `"${commonGitDir}" (the shared .git this worktree points to) does not resolve to a real, existing path: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }
}
