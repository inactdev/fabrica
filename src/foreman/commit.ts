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
  // -c commit.gpgsign=false and --no-verify: same reasoning, applied to the
  // Client's signing config and the project's own commit hooks. A hook that
  // expects installed dependencies (routinely absent in a fresh worktree),
  // or signing that wants a key this machine-made commit has no claim to,
  // would make this commit throw — and a throw here means the finally-block
  // teardown force-removes the worktree with the work still uncommitted,
  // the exact loss this commit exists to prevent.
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Fabrica",
      "-c",
      "user.email=fabrica@local",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--no-verify",
      "-qm",
      message,
    ],
    { cwd: workdir, stdio: ["ignore", "pipe", "pipe"] }
  );
}
