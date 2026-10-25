// Reading one issue from GitHub's REST API, so a task worded "do issue
// #N as written" is handed #N's own words instead of having to ask what
// they say - the issue as it stands, which means its comments too (the
// second call, fetch-comments.ts: a comment is where an amendment or a
// ruling lands).
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
// Why a plain HTTPS call rather than `gh issue view --json`: `gh` would
// put a second spelling of "which issue, which repository" between the
// Client's `--issue` value and the request, needs the binary present at
// all, and a child process is the one thing src/foreman may not spawn
// for anything but git. It is also the wrong credential now - `gh`
// authenticates as the Client himself, and since issue #187 every
// GitHub call Fabrica makes uses a GitHub App token scoped to one
// repository. One documented endpoint, one injectable `fetch`, no
// process.

import { GitHubError } from "./errors.ts";
import { formatIssueRef } from "./issue-ref.ts";
import type { IssueRef } from "./issue-ref.ts";
import { GITHUB_API_ROOT, GITHUB_API_VERSION, apiMessage, githubHeaders, isoUtcSecond } from "./api.ts";
import type { HttpFetch } from "./api.ts";
import { fetchIssueComments } from "./fetch-comments.ts";
import type { IssueComment, OmittedComment } from "./fetch-comments.ts";

// Re-exported, not redeclared: both calls share them (api.ts), and every
// caller and test that already imported them from here keeps working.
export { GITHUB_API_ROOT, GITHUB_API_VERSION };
export type { HttpFetch };

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
  /** Every human-authored comment, oldest first - the issue's
   * amendments and rulings. Empty for an issue with none.
   *
   * Required, not optional, on purpose: a reader that forgot to fetch
   * them would otherwise render as an issue that genuinely has none, and
   * "none" has to stay distinguishable from "not fetched" (the Client's
   * own ruling on this task). An IssueReader that omits it fails to
   * compile. */
  comments: IssueComment[];
  /** Every comment left out as automation rather than an amendment -
   * author and date only, so nothing is silently dropped. */
  omittedComments: OmittedComment[];
  /** When this was read, ISO-8601 UTC to the second. What the "no
   * comments as of ..." line reports, so that line states a fact about
   * a moment rather than a timeless claim. */
  fetchedAt: string;
}

/** Where a task's issue text comes from. One function, so the whole
 * fetch - token, headers, status handling - is replaceable in one piece;
 * what a test actually hands over is the wider seam this is half of
 * (src/foreman/task-issue.ts's `IssueReader`), so no test ever reaches
 * the real API. */
export type IssueSource = (ref: IssueRef) => Promise<FetchedIssue>;

export interface GithubIssueSourceOptions {
  /** A GitHub App installation token minted for this issue's own
   * repository with only `issues: read` (issue #187 - src/githubapp,
   * wired up in src/foreman/github-token.ts). Never logged, never put
   * in a message. */
  token: string;
  fetchImpl?: HttpFetch;
  /** Overridden only by tests pointing at a stub server. */
  apiRoot?: string;
  /** The clock `fetchedAt` is stamped from. Overridden only by tests,
   * which need that line to be the same text on every run. */
  now?: () => Date;
}

/** The real reader: two documented GETs per issue - its own text, then
 * its comments. */
export function githubIssueSource(opts: GithubIssueSourceOptions): IssueSource {
  const fetchImpl = opts.fetchImpl ?? (fetch as HttpFetch);
  const apiRoot = opts.apiRoot ?? GITHUB_API_ROOT;
  return async (ref) => fetchIssue(ref, { ...opts, fetchImpl, apiRoot });
}

export async function fetchIssue(
  ref: IssueRef,
  opts: { token: string; fetchImpl: HttpFetch; apiRoot?: string; now?: () => Date }
): Promise<FetchedIssue> {
  const named = formatIssueRef(ref);
  const url = `${opts.apiRoot ?? GITHUB_API_ROOT}/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(
    ref.repo
  )}/issues/${ref.number}`;

  let status: number;
  let text: string;
  try {
    const response = await opts.fetchImpl(url, { headers: githubHeaders(opts.token) });
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
        `repository, and that Fabrica's GitHub App is installed on it - run \`fabrica doctor\`.`
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

  // Only now, past every refusal the issue's own text can earn: an
  // oversized issue or a pull request is refused without a second
  // request being made at all. The comments are a second documented GET
  // (possibly paginated) and are never optional - a failure there
  // refuses the task too, since an issue read without its amendments is
  // a superseded request and nothing downstream would know.
  const { comments, omittedComments } = await fetchIssueComments(ref, {
    token: opts.token,
    fetchImpl: opts.fetchImpl,
    apiRoot: opts.apiRoot,
  });

  const stamp = (opts.now ?? (() => new Date()))();
  const readAt = Number.isNaN(stamp.getTime()) ? null : isoUtcSecond(stamp.toISOString());

  return {
    ref,
    title,
    body,
    url: typeof fields.html_url === "string" ? fields.html_url : `https://github.com/${ref.owner}/${ref.repo}/issues/${ref.number}`,
    comments,
    omittedComments,
    // A clock this machine cannot read is not a reason to refuse a
    // readable issue - the line says so instead of inventing a moment.
    fetchedAt: readAt ?? "an unknown time",
  };
}
