// Captures what a Worker left uncommitted in a ProductionLine's workdir
// as a unified diff, without ever creating a commit. Used only for the
// discarded-protected-path outcome: rule 9 keeps the work off the branch,
// but "discarded" must not mean "destroyed" — an undeclared gate change is
// often a declaration mistake, not cheating, and the work behind it may be
// entirely good. The diff lands in the task's record folder as
// discarded.patch (see do.ts's comment at the call site).

import { execFileSync } from "node:child_process";

export function captureDiscardedPatch(workdir: string): string {
  // add -A stages everything, including new files, so the diff below sees
  // them; nothing here ever commits, so the branch stays untouched.
  execFileSync("git", ["add", "-A"], { cwd: workdir, stdio: ["ignore", "pipe", "pipe"] });
  return execFileSync("git", ["diff", "--cached", "HEAD"], {
    cwd: workdir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}
