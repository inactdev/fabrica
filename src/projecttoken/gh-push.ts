// Can the `gh` login this machine holds actually publish this project's
// work (issue #331)?
//
// One question, asked with GitHub's own answer rather than guessed:
// `GET /repos/{owner}/{repo}` carries a `permissions` object for the
// authenticated caller, and `permissions.push` is the one field that
// says whether a branch could be pushed and a pull request opened. Read
// from GitHub's answer, never inferred from the login having worked -
// a login that reads fine and cannot write is exactly the shape of
// failure this exists to catch before a round is spent.
//
// The same answer is read by `fabrica doctor`'s project line and by
// `fabrica do`'s start gate, so what the Client is told up front and
// what a task refuses on can never be two different sentences - the
// reason `src/projecttoken/resolve.ts` is shared the same way.
//
// **Evidence versus the absence of it**, the ruling issue #304's own
// start gate was built on and the reason there are three answers here
// and not two: a *definite* no refuses a task (no gh, no login, or
// GitHub itself saying this login cannot push). A read that could not be
// taken at all - the network down, a 500, a body that will not parse -
// is `unknown`: doctor passes the line and says so, and a task starts.
// Refusing on a question nobody could ask would stop work on a project
// that is configured correctly every time the machine is offline.

import { GITHUB_API_ROOT, githubHeaders, apiMessage } from "../github/index.ts";
import type { HttpFetch } from "../github/index.ts";
import { GH_COMMAND, GH_HOSTNAME, GH_LOGIN_COMMAND, ghAuthToken } from "./gh.ts";
import type { GhProblem } from "./gh.ts";

/** What `gh auth status` prints: which account the login belongs to.
 * Named in the fix for a login that cannot push, because the first thing
 * to find out is *who* this machine is logged in as. */
export const GH_STATUS_COMMAND = `${GH_COMMAND} auth status --hostname ${GH_HOSTNAME}`;

/** Whether this project can be published with the `gh` login - yes, a
 * definite no with its fix, or a question that could not be asked. */
export type GhPublishAnswer =
  | { kind: "ok" }
  | ({ kind: "problem" } & GhProblem)
  | {
      kind: "unknown";
      /** One sentence naming what could not be asked, for a doctor line
       * that still passes. Never a fix: there is nothing here for the
       * Client to do about a GitHub that did not answer. */
      detail: string;
    };

export interface GhPublishOptions {
  /** Tests only: a stand-in `gh` on disk (see `ghAuthToken`). */
  command?: string;
  env?: NodeJS.ProcessEnv;
  /** Tests only: a stand-in GitHub. Production uses the global `fetch`. */
  fetchImpl?: HttpFetch;
  /** Tests only: a stand-in API root. */
  apiRoot?: string;
}

/**
 * Whether the `gh` login can push to `owner/repo`, from GitHub's own
 * answer about it.
 *
 * The token is read here, used for this one call, and discarded when it
 * returns - it is never returned to the caller, recorded, or logged (see
 * `gh.ts`'s header for why that matters when the command prints it on
 * stdout).
 */
export async function ghPublishAnswer(
  owner: string,
  repo: string,
  opts: GhPublishOptions = {}
): Promise<GhPublishAnswer> {
  const named = `${owner}/${repo}`;
  const read = ghAuthToken({
    ...(opts.command === undefined ? {} : { command: opts.command }),
    ...(opts.env === undefined ? {} : { env: opts.env }),
  });
  if (read.kind === "problem") return { kind: "problem", detail: read.detail, fix: read.fix };

  const fetchImpl = opts.fetchImpl ?? (fetch as HttpFetch);
  const url = `${opts.apiRoot ?? GITHUB_API_ROOT}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;

  let status: number;
  let text: string;
  try {
    const response = await fetchImpl(url, { headers: githubHeaders(read.token) });
    status = response.status;
    text = await response.text();
  } catch (err) {
    return {
      kind: "unknown",
      detail: `GitHub could not be reached to check whether the gh login can push to ${named} ` +
        `(${err instanceof Error ? err.message : String(err)})`,
    };
  }

  // A credential GitHub turns away is a definite answer about this
  // login, and the fix is to log in again.
  if (status === 401) {
    return {
      kind: "problem",
      detail: `GitHub rejected the token \`${GH_COMMAND}\` holds for ${GH_HOSTNAME} (HTTP 401${apiMessage(text)})`,
      fix: GH_LOGIN_COMMAND,
    };
  }
  // 403 and 404 are the same finding said two ways: on a private
  // repository GitHub answers 404 rather than admitting it exists, so
  // "cannot see it" and "cannot push to it" are one answer to the
  // Client - and both are definite, not an unasked question.
  if (status === 403 || status === 404) {
    return {
      kind: "problem",
      detail:
        `the account \`${GH_COMMAND}\` is logged in as cannot reach ${named} on ${GH_HOSTNAME} ` +
        `(HTTP ${status}${apiMessage(text)})`,
      fix: `check who that is with \`${GH_STATUS_COMMAND}\`, then \`${GH_LOGIN_COMMAND}\` as an account with write access to ${named}`,
    };
  }
  if (status < 200 || status >= 300) {
    return {
      kind: "unknown",
      detail: `GitHub did not answer whether the gh login can push to ${named} (HTTP ${status}${apiMessage(text)})`,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { kind: "unknown", detail: `GitHub's answer about ${named} was not JSON` };
  }
  const permissions =
    typeof parsed === "object" && parsed !== null
      ? (parsed as { permissions?: unknown }).permissions
      : undefined;
  if (typeof permissions !== "object" || permissions === null) {
    // `permissions` is optional in GitHub's own schema for this
    // endpoint. Absent, nothing has been proven either way, so this is
    // not reported as "cannot push" - which would send the Client to
    // fix access he may already have.
    return { kind: "unknown", detail: `GitHub's answer about ${named} carried no permissions for this login` };
  }
  if ((permissions as { push?: unknown }).push === true) return { kind: "ok" };

  return {
    kind: "problem",
    detail:
      `GitHub reports that the account \`${GH_COMMAND}\` is logged in as cannot push to ${named}, so nothing ` +
      `this project produces could be published`,
    fix: `check who that is with \`${GH_STATUS_COMMAND}\`, then either have write access to ${named} granted to it or \`${GH_LOGIN_COMMAND}\` as an account that has it`,
  };
}
