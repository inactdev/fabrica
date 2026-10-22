// Which pull request Inspector's own stdout line names.
//
// Inspector prints "pull request: <url>" and nothing else about it
// (src/inspector/consumer-contract.json), so the URL is all there is to
// go on. Only a github.com pull request URL can be read back over the
// GitHub API; anything else - a self-hosted forge, a test's fixture URL -
// has no API behind it here and is not polled at all.

import type { PullRequestRef } from "./types.ts";

/** The hosts whose pull request URLs the GitHub REST API answers for.
 * `www.` included because a URL copied out of a browser can carry it. */
const GITHUB_HOSTS: ReadonlySet<string> = new Set(["github.com", "www.github.com"]);

/**
 * `{ owner, repo, number }` for a github.com pull request URL, or null
 * for anything else - a different host, a URL that names no pull
 * request, a non-numeric number, or a string that is not a URL at all.
 *
 * Null is "there is nothing here to read", not "something went wrong":
 * the caller records nothing in that case, because a pull request Fabrica
 * cannot address over the API has no checks it could honestly report on.
 */
export function parsePullRequestUrl(url: string): PullRequestRef | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  if (!GITHUB_HOSTS.has(parsed.hostname.toLowerCase())) return null;
  // /<owner>/<repo>/pull/<number> - exactly four segments, so a URL
  // pointing at a review comment or a diff ("/pull/7/files") is still
  // read as pull request 7 only if the extra segments are dropped
  // deliberately below, never by accident.
  const segments = parsed.pathname.split("/").filter((segment) => segment.length > 0);
  if (segments.length < 4) return null;
  const [owner, repo, kind, rawNumber] = segments;
  if (kind !== "pull" && kind !== "pulls") return null;
  if (!/^\d+$/.test(rawNumber)) return null;
  const number = Number(rawNumber);
  if (!Number.isSafeInteger(number) || number <= 0) return null;
  if (owner.length === 0 || repo.length === 0) return null;
  return { owner, repo, number };
}
