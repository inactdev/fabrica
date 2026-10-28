// `fabrica doctor`'s GitHub App line (issue #187's "done when":
// "`fabrica doctor` reports the App installed and no personal token
// configured"). It replaces the old "GitHub token" line entirely -
// nothing reads a personal token any more, so reporting one as present
// and working would be reporting on something unused.
//
// Five questions, in the order they can be answered cheapest-first:
//
//   1. Is an App configured at all, with a key this machine can sign
//      with? (no network - `requireAppCredentials`)
//   2. Does GitHub accept that key? (`GET /app`, which also says how
//      many accounts the App is installed on)
//   3. Is it installed on the repositories Fabrica actually runs tasks
//      on? (an App installed only on some unrelated repository is
//      useless, and the Client has to learn that here rather than
//      mid-task)
//   4. Would a token minted for each of those repositories actually be
//      allowed to publish? (issue #304 - four green tasks were lost to a
//      token that could push and open a pull request but not stamp it)
//   5. Is a personal token still sitting in Fabrica's configuration?
//      That is a warning, not a failure: nothing uses it, which is
//      exactly why it should be revoked.
//
// Question 4 is the one that costs something: it mints a real publishing
// token per project, because a permission GitHub silently left off the
// grant is only visible on the grant (see `publish-permissions.ts`). No
// write is ever attempted with it and it is discarded unread, which is
// the whole reason this check can be run as often as the Client likes.
// It also answers question 3 on the way past - the mint's own
// installation lookup is what 404s on a repository the App is not
// installed on - so the two questions together cost one more API call
// per project than question 3 cost on its own.
//
// The registered projects' repositories arrive as a parameter rather
// than being read here, deliberately: this module knows about GitHub
// Apps, and resolving "which repository is this project" needs
// projects.toml and a git remote, which is `src/cli/doctor-command.ts`'s
// own business (and keeps this module's imports down to one).

import { appSetupFix, leftoverPersonalToken, requireAppCredentials } from "./config.ts";
import { GithubAppError } from "./errors.ts";
import { grantPermissionsFix } from "./granted.ts";
import type { MissingPermission } from "./granted.ts";
import { appIdentity } from "./mint.ts";
import { defaultTokenMinter } from "./minter.ts";
import { publishPermissionGap } from "./publish-permissions.ts";
import type { PublishPermissionGap } from "./publish-permissions.ts";
import type { AppFetch } from "./types.ts";

/** One `fabrica doctor` line. The same shape
 * `src/cli/doctor-command.ts`'s `DoctorCheck` reads, plus `note` for
 * something worth saying on a check that still passes. */
export interface GithubAppCheck {
  ok: boolean;
  label: string;
  detail: string;
  fix?: string;
  note?: string;
}

/** A registered project's GitHub repository, as doctor names it. */
export interface ProjectRepo {
  /** How the project is named in projects.toml, for the message. */
  name: string;
  owner: string;
  repo: string;
}

export const GITHUB_APP_LABEL = "github app";

export async function githubAppStatus(
  env: NodeJS.ProcessEnv,
  recordHome: string,
  /** Every registered project whose `origin` is a github.com
   * repository. A machine with none configured still gets questions 1,
   * 2 and 5 answered - and mints nothing, since there is no repository
   * to mint for. */
  repos: ProjectRepo[] = [],
  opts: { fetchImpl?: AppFetch; apiRoot?: string } = {}
): Promise<GithubAppCheck> {
  const label = GITHUB_APP_LABEL;
  const note = leftoverTokenNote(env, recordHome);

  let credentials;
  try {
    credentials = requireAppCredentials(env, recordHome);
  } catch (err) {
    return { ok: false, label, detail: firstSentence(err), fix: appSetupFix() };
  }

  const call = {
    credentials,
    ...(opts.fetchImpl === undefined ? {} : { fetchImpl: opts.fetchImpl }),
    ...(opts.apiRoot === undefined ? {} : { apiRoot: opts.apiRoot }),
  };

  let identity;
  try {
    identity = await appIdentity(call);
  } catch (err) {
    return { ok: false, label, detail: firstSentence(err), fix: appSetupFix() };
  }
  const named = identity.slug.length > 0 ? identity.slug : "the App";

  if (identity.installations === 0) {
    return {
      ok: false,
      label,
      detail: `${named} is registered and its key works, but it is not installed on any account`,
      fix: 'open the App\'s settings page on github.com and click "Install App"',
    };
  }

  // Asked one repository at a time, which is what the question actually
  // is: an installation covering some repositories and not others is
  // the normal, correct configuration, and the only way to find out
  // whether it covers this project is to ask about this project. The
  // minter is built once so its installation-id cache is shared across
  // the projects, and with no `onMinted` recorder - a preflight has no
  // task to record a mint against.
  const minter = defaultTokenMinter({
    recordHome,
    env,
    ...(opts.fetchImpl === undefined ? {} : { fetchImpl: opts.fetchImpl }),
    ...(opts.apiRoot === undefined ? {} : { apiRoot: opts.apiRoot }),
  });
  const missing: string[] = [];
  const unanswered: string[] = [];
  const gaps: { name: string; gap: PublishPermissionGap }[] = [];
  for (const { name, owner, repo } of repos) {
    try {
      const gap = await publishPermissionGap(minter, owner, repo);
      if (gap !== null) gaps.push({ name, gap });
    } catch (err) {
      if (err instanceof GithubAppError && err.code === "app-not-installed") missing.push(`${name} (${owner}/${repo})`);
      // Anything else is this machine failing to ask, not an answer:
      // reported as unknown rather than as "not installed", which would
      // send the Client to fix a configuration that is already right.
      else unanswered.push(`${name}: ${firstSentence(err)}`);
    }
  }

  // Installation first: a repository the App does not cover cannot be
  // asked about at all, so its permissions are not a second finding -
  // they are the same finding, one step further on.
  if (missing.length > 0) {
    return {
      ok: false,
      label,
      detail: `${named} is installed, but not on ${missing.join(", ")} - tasks on those projects cannot push`,
      fix: `open the App's installation on github.com ("Configure") and add ${missing.length === 1 ? "that repository" : "those repositories"}`,
    };
  }

  // Issue #304: a token that comes back short of what publishing needs.
  // Named per project, since what an installation accepted is per
  // installation - two projects under different accounts can disagree.
  if (gaps.length > 0) {
    return {
      ok: false,
      label,
      detail: `${named} is installed, but ${gaps.map(({ name, gap }) => `for ${name}, ${gap.detail}`).join("; ")}`,
      // One fix line for the union of what is short: the Client is
      // going to one settings page, not one page per project.
      fix: grantPermissionsFix(unionOfMissing(gaps.map(({ gap }) => gap))),
    };
  }

  const reached =
    repos.length === 0
      ? "no registered project has a github.com origin to check"
      : `installed on ${repos.length === 1 ? "the registered project" : `all ${repos.length} registered projects`}` +
        `, and its publishing token carries every permission a handoff needs`;
  const detail = `${named}, ${identity.installations === 1 ? "1 installation" : `${identity.installations} installations`}, ${reached}`;
  const notes = [...(unanswered.length > 0 ? [`could not check ${unanswered.join("; ")}`] : []), ...(note ? [note] : [])];

  return { ok: true, label, detail, ...(notes.length > 0 ? { note: notes.join(" - ") } : {}) };
}

/** Every permission short on any project, once each, at the strongest
 * level any of them needs. Two projects missing the same permission is
 * one setting to change, not two. */
function unionOfMissing(gaps: readonly PublishPermissionGap[]): MissingPermission[] {
  const byKey = new Map<string, MissingPermission>();
  for (const { missing } of gaps) {
    for (const entry of missing) {
      const held = byKey.get(entry.key);
      if (held === undefined || (held.asked === "read" && entry.asked === "write")) byKey.set(entry.key, entry);
    }
  }
  return [...byKey.values()].sort((a, b) => a.key.localeCompare(b.key));
}

/** The leftover-personal-token warning, in the words the Client needs:
 * what to do about it, since nothing reads it any more. */
function leftoverTokenNote(env: NodeJS.ProcessEnv, recordHome: string): string | null {
  const where = leftoverPersonalToken(env, recordHome);
  if (where === null) return null;
  return (
    `a personal GITHUB_TOKEN is still configured in ${where}, and nothing reads it any more - ` +
    `remove it and revoke the token on github.com`
  );
}

/** A doctor line is one line. Every message from this module opens with
 * one complete sentence naming what is wrong, and continues with the
 * steps - which belong in the `fix`, or in the refusal a task prints,
 * not inline beside twelve other checks. */
function firstSentence(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const end = message.search(/\.(\s|$)/);
  return end === -1 ? message.split("\n")[0] : message.slice(0, end);
}
