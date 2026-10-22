// The thin, read-only GitHub REST client this module uses. GET requests
// only - there is deliberately nothing here that can write, so no amount
// of misuse downstream can post, publish or close anything. Fabrica
// never pushes (inspector#18 owns push-inspect-publish) and this module
// never writes to GitHub either; it reads results Inspector's own push
// already caused.
//
// Verified against GitHub's current REST reference (2026-10-22):
//   - the recommended `Accept: application/vnd.github+json`
//   - `X-GitHub-Api-Version`, pinned below
//   - `Authorization: Bearer <token>`
// A log download is documented to answer 302 with a `Location` pointing
// at a plain-text blob that expires after a minute; see `getRedirectText`
// for why that redirect is followed by hand rather than by `fetch`.

import { CiError } from "./errors.ts";

export const GITHUB_API_BASE = "https://api.github.com";

/** The API version every request pins, so a future default change on
 * GitHub's side cannot quietly reshape what this module parses. */
export const GITHUB_API_VERSION = "2022-11-28";

/** How long one request may take before it is given up on. A poll tick
 * that hangs would hold the whole wait open with nothing to show for
 * it; the loop simply tries again on the next tick. */
export const REQUEST_TIMEOUT_MS = 20_000;

/** Node's own `fetch`, as a seam: every test in this module drives a real
 * local HTTP server through a base-url override instead, and this type
 * exists for the one case that cannot (proving the request headers). */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface GithubReaderOptions {
  token: string;
  /** Overridden by tests to point at a local fake; the real base
   * otherwise. Never carries a trailing slash. */
  baseUrl?: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}

export interface GithubReader {
  /** One GET of a documented JSON endpoint. `path` starts with "/". */
  json(path: string): Promise<unknown>;
  /** One GET of an endpoint documented to answer a redirect to a plain
   * text file - the job-log download. Returns null when the endpoint
   * answered something other than a redirect to a readable body. */
  redirectText(path: string): Promise<string | null>;
}

export function createGithubReader(opts: GithubReaderOptions): GithubReader {
  const base = (opts.baseUrl ?? GITHUB_API_BASE).replace(/\/+$/, "");
  const doFetch = opts.fetchImpl ?? ((input, init) => fetch(input, init));
  const timeoutMs = opts.timeoutMs ?? REQUEST_TIMEOUT_MS;

  const headers = (): Record<string, string> => ({
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${opts.token}`,
    "X-GitHub-Api-Version": GITHUB_API_VERSION,
    // GitHub asks every integration to identify itself; an unnamed
    // caller is the first thing rate-limited under load.
    "User-Agent": "fabrica",
  });

  const get = async (path: string, redirect: RequestRedirect): Promise<Response> => {
    try {
      return await doFetch(`${base}${path}`, {
        method: "GET",
        headers: headers(),
        redirect,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      // A failed request must never leak the token, and the only thing
      // in hand that could carry one is the error's own message - which
      // for an undici failure names the URL, not the headers. The path
      // is named instead of the whole URL for the same reason.
      throw new CiError(
        "unreachable",
        `GitHub did not answer GET ${path}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  };

  return {
    async json(path) {
      const res = await get(path, "follow");
      if (!res.ok) {
        throw new CiError("refused", `GitHub answered ${res.status} for GET ${path}${rateLimitNote(res)}`);
      }
      let parsed: unknown;
      try {
        parsed = await res.json();
      } catch (err) {
        throw new CiError(
          "malformed",
          `GitHub's answer to GET ${path} was not JSON: ${err instanceof Error ? err.message : String(err)}`
        );
      }
      return parsed;
    },

    async redirectText(path) {
      // `redirect: "manual"` on purpose. The documented answer is a 302
      // to a signed blob on another host; `fetch`'s own redirect
      // following would carry the Authorization header there, which both
      // hands a third-party host a GitHub token and is not what that
      // host expects. The Location is fetched separately, with no
      // headers of ours at all.
      const res = await get(path, "manual");
      const location = res.headers.get("location");
      if (location === null) return null;
      let blob: Response;
      try {
        blob = await doFetch(location, { method: "GET", signal: AbortSignal.timeout(timeoutMs) });
      } catch {
        // The link is documented to expire after a minute; a log that
        // cannot be downloaded is simply a log this report does without.
        return null;
      }
      if (!blob.ok) return null;
      try {
        return await blob.text();
      } catch {
        return null;
      }
    },
  };
}

/** Worth saying out loud when it is the cause: a 403 with the remaining
 * quota at zero is a rate limit, which reads nothing like a permissions
 * problem but answers with the same status. */
function rateLimitNote(res: Response): string {
  const remaining = res.headers.get("x-ratelimit-remaining");
  if (res.status !== 403 && res.status !== 429) return "";
  if (remaining !== "0") return "";
  const resetAt = res.headers.get("x-ratelimit-reset");
  const when = resetAt === null ? "" : ` (quota resets at ${new Date(Number(resetAt) * 1000).toISOString()})`;
  return ` - the API rate limit is exhausted${when}`;
}
