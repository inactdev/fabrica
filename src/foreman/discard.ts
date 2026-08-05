// Captures everything a Worker changed in a ProductionLine's workdir
// since the commit the line was cut from, as one unified diff, without
// ever creating a commit. Used only for the discarded-protected-path
// outcome: rule 9 keeps the work off the branch, but "discarded" must not
// mean "destroyed" — an undeclared gate change is often a declaration
// mistake, not cheating, and the work behind it may be entirely good. The
// diff lands in the task's record folder as discarded.patch (see do.ts's
// comment at the call site).

import { execFileSync } from "node:child_process";

export function captureDiscardedPatch(workdir: string, baseCommit: string): string {
  // add -A stages untracked files so the diff below sees them — `git diff
  // <commit>` never shows a file the index has no entry for. Nothing here
  // ever commits, so this call alone never moves the branch.
  execFileSync("git", ["add", "-A"], { cwd: workdir, stdio: ["ignore", "pipe", "pipe"] });
  // Diffing against baseCommit (not HEAD) covers a Worker's own commits
  // since the line was cut AND anything left uncommitted, in one patch —
  // a Worker with git access may have committed any amount itself.
  // --binary makes the patch self-contained for binary files too, so
  // `git apply` can restore everything; without it a binary file appears
  // only as a "Binary files ... differ" stub and its content is lost.
  return execFileSync("git", ["diff", "--binary", baseCommit], {
    cwd: workdir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}
