// Commits whatever a Worker left in a ProductionLine's workdir onto its
// branch, before that workdir is destroyed. Resolves the tension PR #43
// flagged: without this, a delivery could either name the files (from the
// worktree, gone at teardown) or preserve the work (the branch, empty with
// nothing ever committed to it) — never both. See do.ts's comment at the
// call site for why a commit here is the fix rather than a validation-only
// workaround.

import { execFileSync } from "node:child_process";
import { ForemanError, describeGitError } from "./errors.ts";

// `git status --porcelain` can report a dirty workdir that `git add -A`
// stages nothing from: a submodule holding untracked content is reported
// modified while its gitlink is unchanged. `git commit` then exits 1 with
// "nothing to commit", which would throw below and hand the caller's
// teardown a worktree it force-removes with the work still uncommitted:
// the exact loss this file exists to prevent, triggered by there being
// nothing to preserve in the first place. Ask the index directly instead
// of inferring from the workdir.
function hasStagedChanges(workdir: string): boolean {
  try {
    execFileSync("git", ["diff", "--cached", "--quiet"], {
      cwd: workdir,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return false;
  } catch (err) {
    // Exit 1 is git's answer "yes, the index differs from HEAD"; anything
    // else is a real failure and belongs in the caller's catch.
    if ((err as { status?: number } | undefined)?.status === 1) return true;
    throw err;
  }
}

export function commitWorktreeChanges(workdir: string, message: string): void {
  try {
    execFileSync("git", ["add", "-A"], { cwd: workdir, stdio: ["ignore", "pipe", "pipe"] });
    if (!hasStagedChanges(workdir)) return;
    // -c user.*: a throwaway worktree has no reason to inherit (or require)
    // the Client's own git identity — every commit here is machine-made.
    // -c commit.gpgsign=false and the two hook settings: same reasoning,
    // applied to the Client's signing config and the project's own commit
    // hooks. A hook that expects installed dependencies (routinely absent in
    // a fresh worktree), or signing that wants a key this machine-made commit
    // has no claim to, would make this commit throw — and a throw here means
    // the finally-block teardown force-removes the worktree with the work
    // still uncommitted, the exact loss this commit exists to prevent.
    // --no-verify is not enough on its own: it only bypasses pre-commit and
    // commit-msg, so a prepare-commit-msg hook still runs and can still abort
    // the commit. Pointing core.hooksPath at a non-directory leaves no hook
    // of any kind discoverable.
    execFileSync(
      "git",
      [
        "-c",
        "user.name=Fabrica",
        "-c",
        "user.email=fabrica@local",
        "-c",
        "commit.gpgsign=false",
        "-c",
        "core.hooksPath=/dev/null",
        "commit",
        "--no-verify",
        "-qm",
        message,
      ],
      { cwd: workdir, stdio: ["ignore", "pipe", "pipe"] }
    );
  } catch (err) {
    throw new ForemanError(
      "commit-failed",
      `could not commit the Worker's changes in ${workdir}: ${describeGitError(err)}`
    );
  }
}
