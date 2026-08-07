// Internal shapes for the off-the-books net (issue #13). Nothing here is
// shared with contract/surface.ts — the only contract-facing pieces this
// feature touches are the "unattributed-change" and "edit-attempt-blocked"
// FabricaEventNames, already ratified there.

/** A registered project's git state at one point in time, as far as this
 * net looks: which branch, which commit, and what the working tree's
 * porcelain status reports (tracked-file changes and untracked-but-not-
 * ignored files only — `git status` already leaves ignored files out). */
export interface ProjectGitState {
  branch: string;
  headCommit: string;
  /** Raw `git status --porcelain=v1` lines, sorted for stable comparison. */
  dirty: string[];
}
