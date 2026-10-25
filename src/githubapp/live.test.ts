// The live half of issue #187's scoping proof (Client ruling,
// clarification 3: "Both: a stubbed test in check.sh proving the
// scoping logic on every pass, and a live test against the real App and
// two fixture repos behind an environment flag, skipping loudly
// elsewhere, the same convention as the real-binary tests").
//
// `mint.test.ts` proves the logic against a stub that behaves the way
// GitHub documents. This proves it against GitHub: it mints a real
// token for one real repository and asks GitHub itself which
// repositories that token can reach.
//
// The question is asked with `GET /installation/repositories`, which is
// documented to "list repositories that an app installation can access"
// when called with an installation access token - so the answer is
// GitHub's own enumeration of the token's reach, not an inference from a
// 403 or a 404 whose meaning the reference leaves open for a repository
// a token cannot see.
//
// Opt-in, like the reference worker adapter's own real-binary run
// (`src/brain/adapters/`) and `src/cli/skill-settings-live.test.ts`'s
// real-session run, and for the same reasons: it needs a credential no
// CI runner has, it
// spends a real rate-limit quota, and it depends on two repositories
// existing on github.com. It skips LOUDLY - a banner naming exactly what
// to set - because a silent skip is a bug (standing ruling), and a
// scoping proof that quietly did not run is the worst kind.

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { requireAppCredentials } from "./config.ts";
import { installationIdFor, mintInstallationToken } from "./mint.ts";
import { READ_ISSUE_PERMISSIONS } from "./scopes.ts";
import { GITHUB_API_ROOT, GITHUB_API_VERSION } from "./mint.ts";

export const LIVE_FLAG = "FABRICA_GITHUB_APP_LIVE";
export const LIVE_REPO_VAR = "FABRICA_GITHUB_APP_LIVE_REPO";
export const LIVE_OTHER_REPO_VAR = "FABRICA_GITHUB_APP_LIVE_OTHER_REPO";

/** `<recordHome>` for the credentials, so this reads the same
 * `brain.env` every other part of Fabrica does. */
const RECORD_HOME = process.env.FABRICA_HOME ?? `${process.env.HOME}/.fabrica`;

function parseRepo(value: string, which: string): { owner: string; repo: string } {
  const [owner, repo, ...rest] = value.split("/");
  assert.ok(owner && repo && rest.length === 0, `${which} must be "owner/repo", not "${value}"`);
  return { owner, repo };
}

/** Why this run is not happening, or null when it is. */
function skipReason(): string | null {
  if (process.env[LIVE_FLAG] !== "1") return `${LIVE_FLAG} is not 1`;
  if (!process.env[LIVE_REPO_VAR]) return `${LIVE_REPO_VAR} is not set`;
  if (!process.env[LIVE_OTHER_REPO_VAR]) return `${LIVE_OTHER_REPO_VAR} is not set`;
  try {
    requireAppCredentials(process.env, RECORD_HOME);
  } catch (err) {
    return `the GitHub App is not configured on this machine (${err instanceof Error ? err.message.split(".")[0] : err})`;
  }
  return null;
}

const SKIP = skipReason();

after(() => {
  if (SKIP === null) return;
  // Loud, not silent: printed on every default `npm test` run so nobody
  // reads a green suite as "the live scoping proof passed".
  const WIDTH = 66;
  const line = (text = "") => `  # ${text.padEnd(WIDTH).slice(0, WIDTH)} #`;
  const rule = `  #${"#".repeat(WIDTH + 2)}#`;
  console.log(
    [
      "",
      rule,
      line("SKIPPED: the LIVE GitHub App scoping proof did not run."),
      line(),
      line(`Why: ${SKIP}`),
      line(),
      line("To run it, on a machine with the App configured:"),
      line(`  ${LIVE_FLAG}=1 \\`),
      line(`  ${LIVE_REPO_VAR}=<owner>/<repo-a> \\`),
      line(`  ${LIVE_OTHER_REPO_VAR}=<owner>/<repo-b> \\`),
      line("  npx tsx --test src/githubapp/live.test.ts"),
      line(),
      line("Both repositories must be in the App's installation, so that"),
      line("what turns the token away is the TOKEN's own scope, not the"),
      line("installation's. mint.test.ts proves the same thing against a"),
      line("stub GitHub on every run."),
      rule,
      "",
    ].join("\n")
  );
});

/** `GET /installation/repositories` with an installation token: GitHub's
 * own list of what that token can reach. */
async function reachableWith(token: string): Promise<{ selection: string; fullNames: string[] }> {
  const response = await fetch(`${GITHUB_API_ROOT}/installation/repositories?per_page=100`, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": GITHUB_API_VERSION,
      "User-Agent": "fabrica",
    },
  });
  assert.equal(response.status, 200, `GitHub answered ${response.status} to GET /installation/repositories`);
  const body = (await response.json()) as {
    repository_selection?: string;
    repositories?: { full_name?: string }[];
  };
  return {
    selection: body.repository_selection ?? "",
    fullNames: (body.repositories ?? []).map((r) => r.full_name ?? "").sort(),
  };
}

test("LIVE: a real minted token reaches exactly the one repository it was minted for", { skip: SKIP ?? false }, async () => {
  const credentials = requireAppCredentials(process.env, RECORD_HOME);
  const a = parseRepo(process.env[LIVE_REPO_VAR]!, LIVE_REPO_VAR);
  const b = parseRepo(process.env[LIVE_OTHER_REPO_VAR]!, LIVE_OTHER_REPO_VAR);

  // Both repositories are in the installation - otherwise this proves
  // nothing about the token, only about where the App is installed.
  const installationA = await installationIdFor({ credentials }, a.owner, a.repo);
  const installationB = await installationIdFor({ credentials }, b.owner, b.repo);
  assert.equal(
    installationA,
    installationB,
    `${LIVE_REPO_VAR} and ${LIVE_OTHER_REPO_VAR} must be in the same installation for this to prove anything`
  );

  const minted = await mintInstallationToken({
    credentials,
    scope: { ...a, permissions: READ_ISSUE_PERMISSIONS },
  });

  assert.equal(minted.repositorySelection, "selected", "GitHub minted a token reaching every repository");
  assert.deepEqual(minted.permissions, { issues: "read" }, "GitHub granted something other than issues: read");

  const reach = await reachableWith(minted.token);
  assert.deepEqual(reach.fullNames, [`${a.owner}/${a.repo}`], "the minted token reaches more than one repository");
  assert.ok(
    !reach.fullNames.includes(`${b.owner}/${b.repo}`),
    "the minted token can reach the second repository - the scoping did not hold"
  );
  assert.equal(reach.selection, "selected");
});

test("LIVE: the expiry GitHub sets is within the hour it documents", { skip: SKIP ?? false }, async () => {
  const credentials = requireAppCredentials(process.env, RECORD_HOME);
  const a = parseRepo(process.env[LIVE_REPO_VAR]!, LIVE_REPO_VAR);

  const minted = await mintInstallationToken({
    credentials,
    scope: { ...a, permissions: READ_ISSUE_PERMISSIONS },
  });

  const lifetimeMs = Date.parse(minted.expiresAt) - Date.now();
  assert.ok(lifetimeMs > 0, `the token GitHub minted is already expired (${minted.expiresAt})`);
  // "Installation access tokens expire after 1 hour" - a little slack
  // either way for the round trip and for clock skew.
  assert.ok(lifetimeMs <= 65 * 60 * 1000, `the token lives longer than an hour (${minted.expiresAt})`);
});

test("LIVE: the App is not installed on a repository that does not exist", { skip: SKIP ?? false }, async () => {
  const credentials = requireAppCredentials(process.env, RECORD_HOME);

  await assert.rejects(
    () => installationIdFor({ credentials }, "fabrica-live-check", "no-such-repository-ever"),
    (err: unknown) => err instanceof Error && /not installed on/.test(err.message)
  );
});
