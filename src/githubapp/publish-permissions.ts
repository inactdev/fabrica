// Can this machine actually publish to one repository? (issue #304)
//
// The only honest way to answer that without writing anything is to mint
// the token the publishing handoff would use and read what GitHub
// granted on it. That is what this does: one mint with
// `PUBLISH_PERMISSIONS`, one comparison, and the token discarded
// unread - nothing here returns it, and the only field it touches is
// `permissions`.
//
// The mint goes through a `TokenMinter` rather than straight to
// `mint.ts`, so the task-start gate's mint is recorded as
// `"token-minted"` by `src/foreman/github-token.ts`'s recording wrapper
// exactly like every other mint, and `fabrica doctor`'s mint - which has
// no task to record against - is the same code path with no recorder
// wired in.

import { missingPermissions, describeMissingPermissions, grantPermissionsFix } from "./granted.ts";
import type { MissingPermission } from "./granted.ts";
import { PUBLISH_PERMISSIONS } from "./scopes.ts";
import type { TokenMinter } from "./types.ts";

/** A publish token GitHub would hand over short of what publishing
 * needs. Both strings are the shared wording: `detail` is one sentence
 * naming what is wrong, `fix` is the setting to change - the split every
 * `fabrica doctor` line uses, and what a task's refusal joins back
 * together. */
export interface PublishPermissionGap {
  owner: string;
  repo: string;
  missing: MissingPermission[];
  detail: string;
  fix: string;
}

/**
 * Null when a token minted for `owner/repo` comes back able to do
 * everything the publishing handoff needs; a gap when it does not.
 *
 * Throws whatever the mint threw - a `GithubAppError` naming an
 * unconfigured App, an installation that does not cover the repository,
 * a revoked key, or GitHub being unreachable. Those are the
 * check-could-not-be-taken cases, and each caller decides what to do
 * about them; this function never turns one into a gap, because "GitHub
 * did not answer" is not evidence that a permission is missing.
 */
export async function publishPermissionGap(
  minter: TokenMinter,
  owner: string,
  repo: string
): Promise<PublishPermissionGap | null> {
  const minted = await minter.mint("publish", { owner, repo, permissions: PUBLISH_PERMISSIONS });
  const missing = missingPermissions(PUBLISH_PERMISSIONS, minted.permissions);
  if (missing.length === 0) return null;
  return {
    owner,
    repo,
    missing,
    detail: publishGapDetail(owner, repo, missing),
    fix: grantPermissionsFix(missing),
  };
}

/** The one sentence both surfaces say. Deliberately about the grant
 * rather than about one call: a reviewer reading it a month later should
 * not have to know which endpoint `statuses: write` is for, only that
 * nothing can be published until the App and its installation agree. */
export function publishGapDetail(owner: string, repo: string, missing: readonly MissingPermission[]): string {
  return (
    `the token GitHub mints for ${owner}/${repo} is missing ${describeMissingPermissions(missing)} - an ` +
    `installation token only ever carries what the App holds and the installation has accepted, so the ` +
    `pull request for a task on this project could not be pushed, opened or stamped`
  );
}
