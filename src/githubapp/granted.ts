// What GitHub actually granted on a minted token, against what the mint
// asked for (issue #304).
//
// GitHub documents one hard ceiling on an installation token - "The
// installation access token cannot be granted permissions that the app
// was not granted" (the reference for `POST
// /app/installations/{installation_id}/access_tokens`, read before this
// was written) - and documents neither of the two ways it enforces it.
// Both have been seen: a refusal (422, which `mint.ts` turns into a
// `mint-refused` naming the permissions), and a 201 whose `permissions`
// map is quietly short of what was asked for. The second is what cost
// four green tasks their publication on 2026-10-27: `statuses: write`
// was simply not in the grant, and nothing looked.
//
// So this module answers one question - which of the permissions a scope
// asked for did the token not come back with - and words the answer in
// the one place both `fabrica doctor` and a task's own refusal read it
// from, so the two can never describe the same shortfall differently.
//
// A shortfall is a *rank* comparison, not equality: an App narrowed from
// write to read is short, one that holds admin where write was asked is
// not. And only the keys the scope asked for are compared - GitHub
// grants `metadata: read` to every installation token implicitly, so it
// arrives on every grant without ever appearing in a Fabrica scope.

import type { AppPermission } from "./types.ts";

/** One permission a minted token did not come back with. */
export interface MissingPermission {
  /** GitHub's own permission key, e.g. `statuses`. */
  key: string;
  /** The level the mint asked for. */
  asked: AppPermission;
  /** What GitHub granted instead, or null when the key was not on the
   * grant at all. */
  granted: string | null;
}

/** GitHub's permission levels, weakest first. `admin` is never asked for
 * by anything in Fabrica (`types.ts`'s `AppPermission` cannot spell it)
 * but can be held, so it ranks here rather than reading as unknown. */
const RANK: Readonly<Record<string, number>> = Object.freeze({ read: 1, write: 2, admin: 3 });

function rank(level: string | undefined): number {
  return level === undefined ? 0 : (RANK[level] ?? 0);
}

/**
 * Every permission `asked` wants that `granted` does not supply at that
 * level or better. Empty means the token can do everything the call it
 * was minted for needs.
 *
 * Sorted by key, so two runs over the same shortfall read identically -
 * the same reason `describePermissions` sorts.
 */
export function missingPermissions(
  asked: Readonly<Record<string, AppPermission>>,
  granted: Readonly<Record<string, string>>
): MissingPermission[] {
  return Object.entries(asked)
    .filter(([key, level]) => rank(granted[key]) < rank(level))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, level]) => ({ key, asked: level, granted: granted[key] ?? null }));
}

/**
 * How GitHub's App settings page names each permission key, for a fix
 * line that can be followed by clicking rather than by translating.
 *
 * Taken from GitHub's own "Permissions required for GitHub Apps"
 * reference, whose repository sections are headed `Repository
 * permissions for "Commit statuses"`, `... "Pull requests"`, and so on,
 * cross-checked against the create-installation-access-token
 * reference's description of each key (`statuses`: "The level of
 * permission to grant the access token for commit statuses"). A key with
 * no entry here falls back to the key itself rather than to a guess.
 */
export const PERMISSION_SETTING_NAMES: Readonly<Record<string, string>> = Object.freeze({
  actions: "Actions",
  checks: "Checks",
  contents: "Contents",
  issues: "Issues",
  metadata: "Metadata",
  pull_requests: "Pull requests",
  statuses: "Commit statuses",
});

/** The App settings page's own name for a permission key. */
export function settingNameFor(key: string): string {
  return PERMISSION_SETTING_NAMES[key] ?? key;
}

/** The level as the App settings page spells it, for the same reason. */
export function settingLevelFor(level: AppPermission): string {
  return level === "write" ? "Read and write" : "Read-only";
}

/** A shortfall as one readable phrase, e.g. `statuses: write (granted
 * read)`. Used verbatim by both surfaces. */
export function describeMissingPermissions(missing: readonly MissingPermission[]): string {
  return missing
    .map(({ key, asked, granted }) => `${key}: ${asked}${granted === null ? " (not granted at all)" : ` (granted ${granted})`}`)
    .join(", ");
}

/**
 * The exact setting to change, in the order the App settings page shows
 * it, and the second half nobody remembers: widening an App's
 * permissions does nothing until the installation accepts it. GitHub's
 * own documentation on modifying permissions is why that sentence is
 * here - "If the account owner does not approve the new permissions,
 * their installation will continue to use the old permissions."
 */
export function grantPermissionsFix(missing: readonly MissingPermission[]): string {
  const settings = missing.map(({ key, asked }) => `${settingNameFor(key)} -> ${settingLevelFor(asked)}`).join("; ");
  return (
    `open the App's settings page on github.com, set Permissions & events -> Repository permissions -> ` +
    `${settings}, then accept the permission change on the installation itself (GitHub emails you a link, ` +
    `or use "Configure")`
  );
}
