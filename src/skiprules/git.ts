// The two git reads an evaluation needs, and nothing else. Both are
// read-only, both run against the project's own repository rather than
// the throwaway worktree (which the caller tears down right after the
// round), and both answer null rather than throwing: a question git
// could not answer is answered "unknown" by the evaluator, which is
// never safe.

import { execFileSync } from "node:child_process";
import type { ChangeCounts } from "./types.ts";

/** A diff can be large; node's default 1 MiB would abort a read for a
 * change big enough that no skip rule would ever have passed it anyway.
 * Generous rather than unbounded - past this the fingerprint is simply
 * null, which is honest. */
const MAX_DIFF_BYTES = 64 * 1024 * 1024;

/**
 * How many files and lines the change moved, from one `git diff
 * --shortstat` - which is `--stat`'s own last line and nothing else
 * (git 2.54.0: `" 2 files changed, 3 insertions(+)"`), so the counts
 * arrive without buffering a whole patch to throw it away.
 *
 * Null when git could not be read at all. A diff with no changes in it
 * prints nothing, which is a real answer - zero of everything - not a
 * failure.
 */
export function changeCounts(project: string, baseCommit: string, branch: string): ChangeCounts | null {
  let out: string;
  try {
    out = execFileSync("git", ["diff", "--shortstat", baseCommit, branch], {
      cwd: project,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    return null;
  }
  const line = out.trim();
  if (line.length === 0) return { files: 0, insertions: 0, deletions: 0 };
  return {
    files: firstNumberBefore(line, "file"),
    insertions: firstNumberBefore(line, "insertion"),
    deletions: firstNumberBefore(line, "deletion"),
  };
}

/** The number immediately preceding `word` in a shortstat line, or 0 when
 * that clause is absent - git omits "0 insertions" entirely rather than
 * printing it. Matched on the word stem so both the singular and plural
 * forms git prints ("1 file changed", "2 files changed") are read. */
function firstNumberBefore(line: string, word: string): number {
  const match = new RegExp(`(\\d+)\\s+${word}`).exec(line);
  return match === null ? 0 : Number(match[1]);
}

/**
 * The change's patch-id fingerprint (issue #204's amendment), so two
 * evaluations can be told apart from two evaluations of the same change -
 * a fix round that changed nothing has the same fingerprint as the round
 * before it.
 *
 * `git patch-id --stable` reads a diff on stdin and prints
 * `"<patch-id> <commit-id>"`, with the commit id all zeros for a raw
 * `git diff` (verified against git 2.54.0 rather than assumed), so only
 * the first field is the fingerprint. Null when either call fails or the
 * diff is empty - patch-id prints nothing for no patch.
 */
export function changeFingerprint(project: string, baseCommit: string, branch: string): string | null {
  try {
    const diff = execFileSync("git", ["diff", baseCommit, branch], {
      cwd: project,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: MAX_DIFF_BYTES,
    });
    if (diff.trim().length === 0) return null;
    const out = execFileSync("git", ["patch-id", "--stable"], {
      cwd: project,
      encoding: "utf8",
      input: diff,
      stdio: ["pipe", "pipe", "pipe"],
      maxBuffer: MAX_DIFF_BYTES,
    });
    const id = out.trim().split(/\s+/)[0] ?? "";
    return /^[0-9a-f]{40,64}$/.test(id) ? id : null;
  } catch {
    return null;
  }
}
