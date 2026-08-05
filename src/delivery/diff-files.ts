// The one place that turns "a branch" into "the files it actually
// changed." Reads straight from the project's own git history — never the
// throwaway ProductionLine workdir — so it works before OR after that
// worktree is destroyed: `destroyProductionLine` only removes the linked
// worktree, never the branch or its commits (src/line/teardown.ts). Both
// the foreman loop (building a delivery's `files` field) and
// validate-files.ts (re-checking one) call this same function, so there is
// exactly one definition of "what a branch touched" to ever disagree with.

import { execFileSync } from "node:child_process";

export function diffFiles(project: string, branch: string): string[] {
  const base = execFileSync("git", ["merge-base", branch, "HEAD"], {
    cwd: project,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

  // -z gives NUL-separated, never-quoted paths, matching files.ts's
  // listTouchedFiles — non-ASCII and quote-bearing names come back exact.
  const raw = execFileSync("git", ["diff", "--name-only", "-z", base, branch], {
    cwd: project,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  return raw.split("\0").filter((path) => path.length > 0);
}
