// Detects an undeclared change to the project's checks (CONTRACT rule 9:
// "It can't grade its own homework in the dark"). v1's one protected path
// is check.sh itself, and only when do() is using it as the check command
// (DEFAULT_CHECK_COMMAND) — the one file a worker could silently rewrite
// to fake a green gate. A registered project with a custom check command
// isn't covered yet; see README.md "Known v1 limitations."
//
// The honest before-state is the task's pinned `baseCommit` — the commit
// the ProductionLine was first cut from — never the file sitting in the
// workdir when a round starts. A rule 6 "fix" round reopens a worktree on
// `fabrica/<taskId>`, which already carries whatever the previous round
// committed, so a worktree-taken snapshot would make a round-1 tamper the
// round-2 baseline: the tampered gate would read as clean, and an honest
// revert of it would read as a fresh violation. Both rounds asking git the
// same question against the same commit removes that whole class of wrong
// answer, and costs nothing extra — `baseCommit` is already pinned and
// already on the "delivered" event.

import { execFileSync } from "node:child_process";
import { ForemanError, describeGitError } from "./errors.ts";

const PROTECTED_PATH = "check.sh";

/** Proves the pristine gate is readable before any worker runs, so a
 * baseline git can't answer is refused up front rather than after a
 * worker has already spent its attempt. */
export function requireGateBaseline(workdir: string, baseCommit: string): void {
  try {
    execFileSync("git", ["cat-file", "-e", `${baseCommit}:${PROTECTED_PATH}`], {
      cwd: workdir,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    throw new ForemanError(
      "gate-baseline-unreadable",
      `Cannot read ${PROTECTED_PATH} as it stood at ${baseCommit}, so there is nothing to prove the ` +
        `project's checks against (rule 9): ${describeGitError(err)}`
    );
  }
}

/** True if check.sh in `workdir` differs from its content at `baseCommit`
 * — regardless of whether a brain declared the change. Deciding whether
 * that's allowed is the caller's job (rule 9): declared changes are fine,
 * undeclared ones force the discarded-protected-path outcome, "no matter
 * how good the result looks" — recorded honestly, work kept on the
 * branch; the merge is blocked by CI, not here (README.md "Rule 9:
 * blocked by CI, not by Fabrica's own mark"). Asking git rather than
 * comparing bytes read from disk also keeps a repository's own checkout
 * filters (e.g. line-ending conversion) from reading as a change. */
export function gateWasTouched(workdir: string, baseCommit: string): boolean {
  try {
    const raw = execFileSync("git", ["diff", "--name-only", "-z", baseCommit, "--", PROTECTED_PATH], {
      cwd: workdir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return raw.split("\0").some((path) => path.length > 0);
  } catch (err) {
    throw new ForemanError(
      "gate-baseline-unreadable",
      `Could not compare ${PROTECTED_PATH} in ${workdir} against ${baseCommit} (rule 9): ` +
        describeGitError(err)
    );
  }
}
