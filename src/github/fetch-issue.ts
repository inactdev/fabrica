// Reading one issue from GitHub's REST API, so a task worded "do issue
// #N as written" is handed #N's own words instead of having to ask what
// they say.
//
// Written against GitHub's current REST reference for "Get an issue"
// (docs.github.com/en/rest/issues/issues), read before this call was
// written rather than recalled: `GET /repos/{owner}/{repo}/issues/{N}`,
// with `Accept: application/vnd.github+json`, `Authorization: Bearer
// <token>` and `X-GitHub-Api-Version`; 200 carries `number`, `title`,
// `body` (string or null) and `html_url`, 301 means the issue was
// transferred, 404 means no such issue (or none this token may read),
// and 410 means it was deleted. The same reference is where
// `pull_request` comes from: "GitHub's REST API considers every pull
// request an issue, but not every issue is a pull request", and that key
// is how a pull request is told apart - a number that turns out to name
// one is refused rather than quietly used as if it were an issue.
//
// Why a plain HTTPS call rather than `gh issue view --json`, which is
// already installed wherever Inspector's token comes from: `gh` would
// put a second spelling of "which issue, which repository" between the
// Client's `--issue` value and the request, needs the binary present
// even when GITHUB_TOKEN is set in the environment, and a child process
// is the one thing src/foreman may not spawn for anything but git. One
// documented endpoint, one injectable `fetch`, no process.

import { GitHubError } from "./errors.ts";
import { formatIssueRef } from "./issue-ref.ts";
import type { IssueRef } from "./issue-ref.ts";

export const GITHUB_API_ROOT = "https://api.github.com";

/** The API version this call is pinned to - GitHub's documented way of
 * saying which version's behavior a request expects, and the current one
 * as of the reference read while writing this. */
export const GITHUB_API_VERSION = "2026-03-10";

/**
 * The hard ceiling the Client set on an issue carried into a brief (64
 * KB of title plus body, measured in UTF-8 bytes): "verbatim and in
 * full on every round - never truncated or summarized. Only above a
 * hard cap refuse at registration naming the size, so a worker never
 * works from a shortened issue without anyone knowing."
 */
export const MAX_ISSUE_BYTES = 64 * 1024;

/** One issue's own words, exactly as GitHub returned them. */
export interface FetchedIssue {
  ref: IssueRef;
  title: string;
  /** Empty string for an issue with no description - GitHub's `body` is
   * nullable, and a brief has no use for the word "null". */
  body: string;
  /** `html_url`: the page a human would open. */
  url: string;
}

/** Where a task's issue text comes from. One function, so the whole
 * fetch - token, headers, status handling - is replaceable in one piece;
 * what a test actually hands over is the wider seam this is half of
 * (src/foreman/task-issue.ts's `IssueReader`), so no test ever reaches
 * the real API. */
export type IssueSource = (ref: IssueRef) => Promise<FetchedIssue>;

/** Just enough of `fetch` for this call: the global one satisfies it,
 * and a fake needs only a status and a body. */
export type HttpFetch = (
  url: string,
  init: { headers: Record<string, string> }
) => Promise<{ status: number; text(): Promise<string> }>;

export interface GithubIssueSourceOptions {
  /** The token Inspector publishes with (src/inspector/run.ts's
   * `resolveGithubToken`) - never logged, never put in a message. */
  token: string;
  fetchImpl?: HttpFetch;
  /** Overridden only by tests pointing at a stub server. */
  apiRoot?: string;
}

/** The real reader: one documented GET per issue. */
export function githubIssueSource(opts: GithubIssueSourceOptions): IssueSource {
  const fetchImpl = opts.fetchImpl ?? (fetch as HttpFetch);
  const apiRoot = opts.apiRoot ?? GITHUB_API_ROOT;
  return async (ref) => fetchIssue(ref, { ...opts, fetchImpl, apiRoot });
}

export async function fetchIssue(
  ref: IssueRef,
  opts: { token: string; fetchImpl: HttpFetch; apiRoot?: string }
): Promise<FetchedIssue> {
  const named = formatIssueRef(ref);
  const url = `${opts.apiRoot ?? GITHUB_API_ROOT}/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(
    ref.repo
  )}/issues/${ref.number}`;

  let status: number;
  let text: string;
  try {
    const response = await opts.fetchImpl(url, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${opts.token}`,
        "X-GitHub-Api-Version": GITHUB_API_VERSION,
        "User-Agent": "fabrica",
      },
    });
    status = response.status;
    text = await response.text();
  } catch (err) {
    throw new GitHubError(
      "issue-fetch-failed",
      `Could not reach GitHub to read ${named}: ${err instanceof Error ? err.message : String(err)}.`
    );
  }

  if (status === 404 || status === 410) {
    throw new GitHubError(
      "issue-not-found",
      `GitHub has no issue ${named} this token can read (HTTP ${status}). Check the number and the ` +
        `repository, and that the token Inspector publishes with may read it.`
    );
  }
  if (status === 301) {
    throw new GitHubError(
      "issue-moved",
      `Issue ${named} was transferred to another repository (HTTP 301). Name the issue where it lives now, ` +
        `as owner/repo#N or its URL.`
    );
  }
  if (status < 200 || status >= 300) {
    throw new GitHubError(
      "issue-fetch-failed",
      `GitHub refused to read issue ${named} (HTTP ${status})${apiMessage(text)}.`
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new GitHubError("issue-unreadable", `GitHub's answer for issue ${named} was not JSON.`);
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new GitHubError("issue-unreadable", `GitHub's answer for issue ${named} was not an issue.`);
  }
  const fields = parsed as Record<string, unknown>;
  if (fields.pull_request !== undefined && fields.pull_request !== null) {
    throw new GitHubError(
      "issue-is-pull-request",
      `${named} is a pull request, not an issue (GitHub's API returns both from this endpoint). ` +
        `Name the issue it belongs to instead.`
    );
  }
  if (typeof fields.title !== "string") {
    throw new GitHubError("issue-unreadable", `GitHub's answer for issue ${named} carried no title.`);
  }

  const title = fields.title;
  const body = typeof fields.body === "string" ? fields.body : "";
  const bytes = Buffer.byteLength(title, "utf8") + Buffer.byteLength(body, "utf8");
  if (bytes > MAX_ISSUE_BYTES) {
    throw new GitHubError(
      "issue-too-large",
      `Issue ${named} is ${bytes} bytes of title and body, past the ${MAX_ISSUE_BYTES}-byte ceiling for an ` +
        `issue carried into a brief. It is never shortened to fit: split the issue, or write the task out ` +
        `in your own words instead.`
    );
  }

  return {
    ref,
    title,
    body,
    url: typeof fields.html_url === "string" ? fields.html_url : `https://github.com/${ref.owner}/${ref.repo}/issues/${ref.number}`,
  };
}

/** GitHub's own one-line explanation from an error body, when it sent
 * one - a bare status code tells the Client nothing about a bad token or
 * a rate limit. Never the whole body: that can be long, and this is read
 * in a terminal. */
function apiMessage(text: string): string {
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
