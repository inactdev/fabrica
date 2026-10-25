// The three GitHub calls a GitHub App's own credentials make, and
// nothing else.
//
// Written against GitHub's current REST reference for Apps
// (docs.github.com/en/rest/apps/apps), read before these calls were
// written rather than recalled:
//
//   GET  /app                                          the App itself
//   GET  /repos/{owner}/{repo}/installation            which installation covers a repo
//   POST /app/installations/{installation_id}/access_tokens
//
// All three authenticate with the App's JWT (`Authorization: Bearer
// <jwt>`), carry `Accept: application/vnd.github+json` and pin
// `X-GitHub-Api-Version`. The mint endpoint's documented body
// parameters are `repositories` (names), `repository_ids` and
// `permissions`; its documented answers are 201 with `token`,
// `expires_at`, `permissions`, `repository_selection`, and 401, 403,
// 404 and 422 for refusals. Two documented behaviours this leans on:
// omitting `repositories` gives the token every repository the
// installation already has (so it is never omitted), and `permissions`
// "cannot exceed" what the App itself holds (so a set GitHub narrows is
// read back off the response rather than echoed from the request).
//
// Nothing here caches a token, and nothing here writes to the record:
// `src/foreman/github-token.ts` is what appends `"token-minted"`, the
// same split `src/foreman/inspection.ts` draws for Inspector's own
// events - the outside call is a seam a test fakes, the recording lives
// in Fabrica's own code where no fake can skip it.

import { GithubAppError } from "./errors.ts";
import { appJwt } from "./jwt.ts";
import type { AppCredentials } from "./config.ts";
import type { AppFetch, AppIdentity, GithubScope, MintedToken } from "./types.ts";

export const GITHUB_API_ROOT = "https://api.github.com";

/** The API version these calls are pinned to - GitHub's documented way
 * of saying which version's behaviour a request expects, and the
 * current one as of the reference read while writing this. The same
 * value `src/github/fetch-issue.ts` pins; deliberately a second
 * constant rather than a shared one, since the two modules read
 * different references and may be re-read at different times. */
export const GITHUB_API_VERSION = "2026-03-10";

/** How long one call may take before it is given up on. A mint that
 * hangs would hold a whole round open with nothing to show for it. */
export const REQUEST_TIMEOUT_MS = 20_000;

export interface AppCallOptions {
  credentials: AppCredentials;
  fetchImpl?: AppFetch;
  /** Overridden only by tests pointing at a stub server. */
  apiRoot?: string;
  /** Milliseconds since the epoch. A seam for the JWT's claims; the
   * real clock otherwise. */
  now?: () => number;
}

interface Answered {
  status: number;
  body: string;
}

function root(opts: AppCallOptions): string {
  return (opts.apiRoot ?? GITHUB_API_ROOT).replace(/\/+$/, "");
}

/** One call, with the App's JWT. Every failure to even reach GitHub
 * becomes `mint-unreachable` naming the path - never the URL with its
 * headers, and never the token, which for a failed request is the only
 * thing in hand that could carry one. */
async function call(
  opts: AppCallOptions,
  method: "GET" | "POST",
  path: string,
  body?: unknown
): Promise<Answered> {
  const fetchImpl = opts.fetchImpl ?? (defaultFetch as AppFetch);
  const nowSeconds = Math.floor((opts.now?.() ?? Date.now()) / 1000);
  const jwt = appJwt(opts.credentials.appId, opts.credentials.privateKeyPem, nowSeconds);
  try {
    const response = await fetchImpl(`${root(opts)}${path}`, {
      method,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${jwt}`,
        "X-GitHub-Api-Version": GITHUB_API_VERSION,
        // GitHub asks every integration to identify itself; an unnamed
        // caller is the first thing rate-limited under load.
        "User-Agent": "fabrica",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.text() };
  } catch (err) {
    throw new GithubAppError(
      "mint-unreachable",
      `GitHub did not answer ${method} ${path}: ${err instanceof Error ? err.message : String(err)}.`
    );
  }
}

/** Node's own `fetch`, with the per-call timeout every call shares. */
const defaultFetch: AppFetch = (url, init) =>
  fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });

function parsed(path: string, answered: Answered): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(answered.body);
  } catch {
    throw new GithubAppError("mint-unreachable", `GitHub's answer to ${path} was not JSON.`);
  }
  if (typeof value !== "object" || value === null) {
    throw new GithubAppError("mint-unreachable", `GitHub's answer to ${path} was not an object.`);
  }
  return value as Record<string, unknown>;
}

/** GitHub's own one-line explanation from an error body, when it sent
 * one - a bare status code tells the Client nothing about a revoked key
 * or a permission the installation does not hold. Never the whole body:
 * that can be long, and this is read in a terminal. */
function apiMessage(body: string): string {
  try {
    const value = JSON.parse(body) as { message?: unknown };
    if (typeof value.message === "string" && value.message.trim().length > 0) return `: ${value.message.trim()}`;
  } catch {
    // Not JSON - the status code is all there is to report.
  }
  return "";
}

/** What `GET /app` says about the App this machine holds a key for.
 * `fabrica doctor`'s proof that the key signs a JWT GitHub accepts -
 * there is no cheaper way to find that out, since every other App
 * endpoint needs the same signature. */
export async function appIdentity(opts: AppCallOptions): Promise<AppIdentity> {
  const path = "/app";
  const answered = await call(opts, "GET", path);
  if (answered.status === 401) {
    throw new GithubAppError(
      "mint-refused",
      `GitHub rejected the GitHub App's own credentials (HTTP 401)${apiMessage(answered.body)}. Either ` +
        `the App id is not this App's, or the private key at ${opts.credentials.keyPath} has been revoked - ` +
        `generate a new one on the App's settings page and replace that file.`
    );
  }
  if (answered.status < 200 || answered.status >= 300) {
    throw new GithubAppError(
      "mint-refused",
      `GitHub refused to describe the GitHub App (HTTP ${answered.status})${apiMessage(answered.body)}.`
    );
  }
  const fields = parsed(path, answered);
  return {
    slug: typeof fields.slug === "string" ? fields.slug : "",
    name: typeof fields.name === "string" ? fields.name : "",
    installations: typeof fields.installations_count === "number" ? fields.installations_count : 0,
  };
}

/**
 * Which installation covers `owner/repo`. GitHub answers 404 both for a
 * repository the App is not installed on and for one it cannot see at
 * all, so the two share one refusal that names the fix for either.
 */
export async function installationIdFor(
  opts: AppCallOptions,
  owner: string,
  repo: string
): Promise<number> {
  const path = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/installation`;
  const answered = await call(opts, "GET", path);
  if (answered.status === 404) {
    throw new GithubAppError(
      "app-not-installed",
      `The GitHub App is not installed on ${owner}/${repo} (GitHub answered 404), so no token can be minted ` +
        `for it. Open the App's settings page on github.com, click "Install App" (or "Configure" if it is ` +
        `already installed elsewhere), and add ${owner}/${repo} to the repositories it may access.`
    );
  }
  if (answered.status === 401) {
    throw new GithubAppError(
      "mint-refused",
      `GitHub rejected the GitHub App's own credentials while looking up ${owner}/${repo} (HTTP 401)` +
        `${apiMessage(answered.body)}. Check ${opts.credentials.keyPath} is the App's current private key.`
    );
  }
  if (answered.status < 200 || answered.status >= 300) {
    throw new GithubAppError(
      "mint-refused",
      `GitHub refused to say which installation covers ${owner}/${repo} (HTTP ${answered.status})` +
        `${apiMessage(answered.body)}.`
    );
  }
  const fields = parsed(path, answered);
  if (typeof fields.id !== "number") {
    throw new GithubAppError(
      "mint-unreachable",
      `GitHub's installation answer for ${owner}/${repo} carried no numeric id.`
    );
  }
  return fields.id;
}

/**
 * One installation token, limited to `scope.owner/scope.repo` and to
 * `scope.permissions`. Lives one hour on GitHub's side and is discarded
 * by its caller as soon as the call it was minted for is done.
 *
 * `repositories` always names exactly one repository: GitHub documents
 * that omitting it grants the token every repository the installation
 * has, which is the breadth this whole module exists to remove.
 */
export async function mintInstallationToken(
  opts: AppCallOptions & { scope: GithubScope; installationId?: number }
): Promise<MintedToken> {
  const { scope } = opts;
  const installationId = opts.installationId ?? (await installationIdFor(opts, scope.owner, scope.repo));
  const path = `/app/installations/${installationId}/access_tokens`;
  const answered = await call(opts, "POST", path, {
    repositories: [scope.repo],
    permissions: scope.permissions,
  });

  if (answered.status === 403 || answered.status === 422) {
    throw new GithubAppError(
      "mint-refused",
      `GitHub refused to mint a token for ${scope.owner}/${scope.repo} with ` +
        `${describePermissions(scope.permissions)} (HTTP ${answered.status})${apiMessage(answered.body)}. The ` +
        `App's own permissions have to include every one of those - a token can never exceed them. Open the ` +
        `App's settings page, grant the missing ones under "Repository permissions", then accept the ` +
        `permission change on the installation itself (GitHub emails you a link, or use "Configure").`
    );
  }
  if (answered.status === 401) {
    throw new GithubAppError(
      "mint-refused",
      `GitHub rejected the GitHub App's own credentials while minting a token for ` +
        `${scope.owner}/${scope.repo} (HTTP 401)${apiMessage(answered.body)}. Check ` +
        `${opts.credentials.keyPath} is the App's current private key.`
    );
  }
  if (answered.status < 200 || answered.status >= 300) {
    throw new GithubAppError(
      "mint-refused",
      `GitHub refused to mint a token for ${scope.owner}/${scope.repo} (HTTP ${answered.status})` +
        `${apiMessage(answered.body)}.`
    );
  }

  const fields = parsed(path, answered);
  if (typeof fields.token !== "string" || fields.token.length === 0) {
    throw new GithubAppError(
      "mint-unreachable",
      `GitHub's answer for a token on ${scope.owner}/${scope.repo} carried no token.`
    );
  }
  return {
    token: fields.token,
    expiresAt: typeof fields.expires_at === "string" ? fields.expires_at : "",
    owner: scope.owner,
    repo: scope.repo,
    // Read back off the response, never echoed from the request: GitHub
    // may narrow a permission set and the record must say what is true.
    permissions: readPermissions(fields.permissions),
    installationId,
    repositorySelection:
      typeof fields.repository_selection === "string" ? fields.repository_selection : "",
  };
}

function readPermissions(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null) return {};
  const out: Record<string, string> = {};
  for (const [key, level] of Object.entries(value as Record<string, unknown>)) {
    if (typeof level === "string") out[key] = level;
  }
  return out;
}

/** A permission set as one readable phrase, for a message and for the
 * record's own detail line. Sorted, so two mints of the same set never
 * read differently. */
export function describePermissions(permissions: Readonly<Record<string, string>>): string {
  const entries = Object.entries(permissions).sort(([a], [b]) => a.localeCompare(b));
  return entries.length === 0 ? "no permissions" : entries.map(([key, level]) => `${key}: ${level}`).join(", ");
}
