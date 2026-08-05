// Commits whatever a Worker left in a ProductionLine's workdir onto its
// branch, before that workdir is destroyed. Resolves the tension PR #43
// flagged: without this, a delivery could either name the files (from the
// worktree, gone at teardown) or preserve the work (the branch, empty with
// nothing ever committed to it) — never both. See do.ts's comment at the
// call site for why a commit here is the fix rather than a validation-only
// workaround.

import { execFileSync } from "node:child_process";

export function commitWorktreeChanges(workdir: string, message: string): void {
  execFileSync("git", ["add", "-A"], { cwd: workdir, stdio: ["ignore", "pipe", "pipe"] });
  // -c user.*: a throwaway worktree has no reason to inherit (or require)
  // the Client's own git identity — every commit here is machine-made.
  execFileSync(
    "git",
    ["-c", "user.name=Fabrica", "-c", "user.email=fabrica@local", "commit", "-qm", message],
    { cwd: workdir, stdio: ["ignore", "pipe", "pipe"] }
  );
}
