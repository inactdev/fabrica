// The bits of GitHub's HTTP API that both calls in this module share -
// the root, the pinned version, the headers its reference names, and how
// an error body's own one-line explanation is read back.
//
// Here rather than in fetch-issue.ts because fetch-issue.ts now calls
// fetch-comments.ts: one of the two would otherwise have to import the
// other's constants and the pair would be a cycle. Both files import
// this one, so the two calls can never drift apart on which version
// they ask for or which headers they send.

/** Just enough of `fetch` for these calls: the global one satisfies it,
 * and a fake needs only a status and a body. Deliberately no response
 * headers - pagination here is walked by asking for the next page until
 * one comes back short, so nothing needs to read `Link` (see
 * fetch-comments.ts). */
export type HttpFetch = (
  url: string,
  init: { headers: Record<string, string> }
) => Promise<{ status: number; text(): Promise<string> }>;

export const GITHUB_API_ROOT = "https://api.github.com";

/** The API version these calls are pinned to - GitHub's documented way
 * of saying which version's behavior a request expects, and the current
 * one as of the reference read while writing this. */
export const GITHUB_API_VERSION = "2026-03-10";

/** The headers GitHub's reference names for a REST call, plus the
 * `User-Agent` it asks every client to send. The token is never logged,
 * printed, or recorded - this is the only place it appears. */
export function githubHeaders(token: string): Record<string, string> {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": GITHUB_API_VERSION,
    "User-Agent": "fabrica",
  };
}

/** GitHub's own one-line explanation from an error body, when it sent
 * one - a bare status code tells the Client nothing about a bad token or
 * a rate limit. Never the whole body: that can be long, and this is read
 * in a terminal. */
export function apiMessage(text: string): string {
  try {
    const parsed = JSON.parse(text) as { message?: unknown };
    if (typeof parsed.message === "string" && parsed.message.trim().length > 0) {
      return `: ${parsed.message.trim()}`;
    }
  } catch {
    // Not JSON - the status code is all there is to report.
  }
  return "";
}

/**
 * One timestamp as the record and every brief spell it: ISO-8601, UTC,
 * to the second. GitHub's own `created_at`/`updated_at` already arrive
 * in exactly that form, and are passed through untouched; anything else
 * readable as a date is normalized to it, and anything unreadable
 * answers null so the caller can refuse rather than carry a comment
 * whose place in the order is unknown.
 */
export function isoUtcSecond(value: unknown): string | null {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  const text = value.trim();
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(text)) return text;
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) return null;
  return `${parsed.toISOString().slice(0, 19)}Z`;
}
