// The one place that turns "a branch" into "the files it actually
// changed." Reads straight from the project's own git history — never the
// throwaway ProductionLine workdir — so it works before OR after that
// worktree is destroyed: `destroyProductionLine` only removes the linked
// worktree, never the branch or its commits (src/line/teardown.ts). The
// foreman loop (src/foreman/do.ts) builds a delivery's `files` field from
// this function, so there is exactly one definition of "what a branch
// touched" — `files` IS this diff, which is why nothing re-checks it
// (see README.md's "Why there's no check against the branch's real diff").

import { execFileSync } from "node:child_process";
import { DeliveryError } from "./errors.ts";

// Same shape as src/line/safety.ts's describeGitError — duplicated locally
// on purpose rather than imported across module boundaries.
function describeGitError(err: unknown): string {
  const stderr = (err as { stderr?: Buffer | string } | undefined)?.stderr;
  if (stderr && stderr.toString().trim().length > 0) return stderr.toString().trim();
  return err instanceof Error ? err.message : String(err);
}

/** HEAD of a workdir, for pinning a diff's fork point to the exact commit
 * a ProductionLine was cut from (see diffFiles's `base`). */
export function baseCommitOf(workdir: string): string {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: workdir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (err) {
    throw new DeliveryError(
      "branch-unreadable",
      `could not read the base commit of ${workdir}: ${describeGitError(err)}`
    );
  }
}

export function diffFiles(project: string, branch: string, base?: string): string[] {
  // `base`, when given, is the fork point recorded at the moment the
  // ProductionLine was cut (baseCommitOf above) — immune to the Client's
  // own checkout wandering to another branch mid-task. When omitted, fall
  // back to merge-base against the project's current HEAD, for a caller
  // with a branch but no ProductionLine to pin a base from.
  try {
    const forkPoint =
      base ??
      execFileSync("git", ["merge-base", branch, "HEAD"], {
        cwd: project,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();

    // -z gives NUL-separated, never-quoted paths, matching files.ts's
    // listTouchedFiles — non-ASCII and quote-bearing names come back exact.
    // Node's default maxBuffer (1 MiB) is too small to trust for git
    // output that scales with the changeset - a huge file list must not
    // abort delivery mid-flight (see src/foreman/discard.ts for the
    // rule-9 stakes of a git capture dying on buffer overflow).
    const raw = execFileSync("git", ["diff", "--name-only", "-z", forkPoint, branch], {
      cwd: project,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 100 * 1024 * 1024,
    });

    return raw.split("\0").filter((path) => path.length > 0);
  } catch (err) {
    // A branch a delivery merely claims to exist is an untrusted claim like
    // any other — reject it with a Client-presentable DeliveryError, never
    // a raw child-process exception.
    throw new DeliveryError(
      "branch-unreadable",
      `could not diff branch "${branch}" in ${project}: ${describeGitError(err)}`
    );
  }
}
