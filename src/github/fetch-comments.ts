// Reading one issue's comments from GitHub's REST API, so a task that
// names an issue is handed the issue as it stands rather than as it was
// first written: a comment is where an amendment or a ruling lands, and
// an issue read without them is a superseded request.
//
// Written against GitHub's current REST reference for "List issue
// comments" (docs.github.com/en/rest/issues/comments), read before this
// call was written rather than recalled: `GET
// /repos/{owner}/{repo}/issues/{issue_number}/comments`, with the same
// `Accept` / `Authorization` / `X-GitHub-Api-Version` headers the issue
// call sends; `per_page` defaults to 30 with a documented maximum of
// 100, `page` defaults to 1, and "issue comments are ordered by
// ascending ID" - so the API's own order is the order they were posted
// in, which is the order this module keeps. There is deliberately no
// `sort`/`direction` here: that reference states those exist only on the
// repository-wide `GET /repos/{owner}/{repo}/issues/comments` variant.
// Each comment carries `user` (`login` and `type`, or null for a deleted
// account), `created_at`, `updated_at`, `body` and `html_url`; 200, 404
// and 410 are the documented statuses.
//
// Three rules the Client set for this, all of them visible below:
//
//   1. **Human-authored comments only.** Automation's comments would
//      read to a machine as rulings. They are never carried as text -
//      but never silently dropped either: author and date go on one
//      "left out" line (see src/foreman/task-issue.ts's rendering).
//   2. **No cap on the count, and the oldest are never dropped** - the
//      ordering is the point. Only a single comment past
//      MAX_COMMENT_CHARS is cut, and then loudly, naming the comment,
//      its author and how much was left out.
//   3. **Everything fails loudly.** A comments page that cannot be read
//      refuses, so a worker is never handed a half-read issue.

import { GitHubError } from "./errors.ts";
import { formatIssueRef } from "./issue-ref.ts";
import type { IssueRef } from "./issue-ref.ts";
import { GITHUB_API_ROOT, apiMessage, githubHeaders, isoUtcSecond } from "./api.ts";
import type { HttpFetch } from "./api.ts";

/** GitHub's documented maximum page size for this endpoint. Asked for in
 * full, so the fewest possible requests read the most comments. */
export const COMMENTS_PER_PAGE = 100;

/**
 * The runaway guard on the page walk, not a cap on comments: at
 * `COMMENTS_PER_PAGE` each, this is 10,000 comments, past anything a
 * real issue carries. It exists because the walk stops on the first
 * short page, so an API that ignored `page` and answered the first one
 * forever would otherwise loop forever. Reaching it refuses, loudly,
 * rather than carrying whatever was read so far.
 */
export const MAX_COMMENT_PAGES = 100;

/**
 * The Client's ceiling on a single comment (ruling on this task: "a
 * single comment longer than 4000 characters is cut at that length with
 * a loud marker naming the comment, its author, and how much was cut").
 * Counted in code points, not UTF-16 code units, so a cut never lands
 * inside a surrogate pair and leaves half an emoji behind.
 */
export const MAX_COMMENT_CHARS = 4000;

/** One human-authored comment, as a brief carries it. */
export interface IssueComment {
  /** The author's GitHub handle, or "unknown" for a comment whose
   * account is gone (GitHub's `user` is nullable). Never empty: the
   * fixed line every comment opens with names an author. */
  author: string;
  /** `created_at`, ISO-8601 UTC to the second. */
  postedAt: string;
  /** `updated_at`, when it differs from `created_at` - null for a
   * comment that was never edited. The current text is always what is
   * carried; both dates are shown so the reader can tell a late
   * amendment from an early one. */
  editedAt: string | null;
  /** `html_url`: the page a human would open, and what a cut marker
   * names so the full text can be read. */
  url: string;
  /** The comment's own words, verbatim, cut at `MAX_COMMENT_CHARS` code
   * points. */
  body: string;
  /** The original length in code points when this comment was cut, else
   * null - what the loud marker reports. */
  fullLength: number | null;
}

/** One comment left out of the brief as automation rather than an
 * amendment: named, so nothing is silently dropped, but not quoted. */
export interface OmittedComment {
  author: string;
  postedAt: string;
}

/** Every comment on one issue, split the way a brief carries them. */
export interface IssueComments {
  comments: IssueComment[];
  omittedComments: OmittedComment[];
}

export interface CommentsFetchOptions {
  token: string;
  fetchImpl: HttpFetch;
  apiRoot?: string;
}

/**
 * Every comment on one issue, oldest first, in GitHub's own order.
 *
 * Throws `GitHubError` naming the cause for an unreachable GitHub, any
 * status that is not a success, an answer that is not a list of
 * comments, a comment with no readable posted date, and a page walk that
 * passes `MAX_COMMENT_PAGES`.
 */
export async function fetchIssueComments(
  ref: IssueRef,
  opts: CommentsFetchOptions
): Promise<IssueComments> {
  const named = formatIssueRef(ref);
  const base =
    `${opts.apiRoot ?? GITHUB_API_ROOT}/repos/${encodeURIComponent(ref.owner)}/` +
    `${encodeURIComponent(ref.repo)}/issues/${ref.number}/comments`;

  const comments: IssueComment[] = [];
  const omittedComments: OmittedComment[] = [];

  for (let page = 1; page <= MAX_COMMENT_PAGES; page += 1) {
    const entries = await readCommentsPage(`${base}?per_page=${COMMENTS_PER_PAGE}&page=${page}`, named, opts);
    for (const entry of entries) {
      const read = readComment(entry, named);
      if (read.fromBot) omittedComments.push({ author: read.author, postedAt: read.postedAt });
      else comments.push(read.comment);
    }
    // The walk stops on the first page that is not full - the documented
    // end of a paginated list, and the one signal available without
    // reading response headers.
    if (entries.length < COMMENTS_PER_PAGE) return { comments, omittedComments };
  }

  throw new GitHubError(
    "issue-comments-unbounded",
    `Reading the comments on issue ${named} passed ${MAX_COMMENT_PAGES} pages of ${COMMENTS_PER_PAGE} without ` +
      `reaching the end. Nothing partial was used. Either that issue is far larger than this was built for, or ` +
      `GitHub is ignoring the page parameter; write the task out in your own words instead.`
  );
}

/** One page of comments, as a list of raw JSON objects. */
async function readCommentsPage(
  url: string,
  named: string,
  opts: CommentsFetchOptions
): Promise<Record<string, unknown>[]> {
  let status: number;
  let text: string;
  try {
    const response = await opts.fetchImpl(url, { headers: githubHeaders(opts.token) });
    status = response.status;
    text = await response.text();
  } catch (err) {
    throw new GitHubError(
      "issue-comments-fetch-failed",
      `Could not reach GitHub to read the comments on ${named}: ${err instanceof Error ? err.message : String(err)}.`
    );
  }

  if (status === 404 || status === 410) {
    throw new GitHubError(
      "issue-comments-fetch-failed",
      `GitHub has no comments on issue ${named} this token can read (HTTP ${status}). The issue's own text was ` +
        `readable, so this is a permission or a rate limit rather than a wrong number - a task is never run on an ` +
        `issue whose amendments could not be read.`
    );
  }
  if (status < 200 || status >= 300) {
    throw new GitHubError(
      "issue-comments-fetch-failed",
      `GitHub refused to read the comments on issue ${named} (HTTP ${status})${apiMessage(text)}.`
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new GitHubError(
      "issue-comments-unreadable",
      `GitHub's answer for the comments on issue ${named} was not JSON.`
    );
  }
  if (!Array.isArray(parsed)) {
    throw new GitHubError(
      "issue-comments-unreadable",
      `GitHub's answer for the comments on issue ${named} was not a list of comments.`
    );
  }
  return parsed.map((entry, index) => {
    if (typeof entry !== "object" || entry === null) {
      throw new GitHubError(
        "issue-comments-unreadable",
        `Comment ${index + 1} in GitHub's answer for issue ${named} was not a comment.`
      );
    }
    return entry as Record<string, unknown>;
  });
}

/** One raw comment, read into either a carried comment or a named
 * omission. Refuses rather than guessing at a missing posted date: the
 * order is what the whole section is for. */
function readComment(
  entry: Record<string, unknown>,
  named: string
): { fromBot: true; author: string; postedAt: string } | { fromBot: false; comment: IssueComment } {
  const user = typeof entry.user === "object" && entry.user !== null ? (entry.user as Record<string, unknown>) : null;
  const login = typeof user?.login === "string" && user.login.trim().length > 0 ? user.login.trim() : null;
  const postedAt = isoUtcSecond(entry.created_at);
  if (postedAt === null) {
    throw new GitHubError(
      "issue-comments-unreadable",
      `A comment on issue ${named}${login ? ` by ${login}` : ""} carried no readable posted date, so where it ` +
        `belongs in the order is unknown. Nothing partial was used.`
    );
  }

  if (login === null) {
    // A deleted account: the handle is gone, the words are still a
    // ruling someone made, so the comment is carried with its author
    // named as what is actually known about it.
    return { fromBot: false, comment: buildComment("unknown", postedAt, entry) };
  }
  if (authoredByBot(login, user?.type)) return { fromBot: true, author: login, postedAt };
  return { fromBot: false, comment: buildComment(login, postedAt, entry) };
}

/** Whether a comment is automation's rather than a person's, by the two
 * facts GitHub actually publishes: the account's own `type`, which is
 * "Bot" for an app's installation, and the `[bot]` suffix every such
 * login carries. Automation driven by a person's own token is
 * indistinguishable from that person here, by design - there is no field
 * that says otherwise, and guessing from the text would drop real
 * rulings. */
function authoredByBot(login: string, type: unknown): boolean {
  if (typeof type === "string" && type.toLowerCase() === "bot") return true;
  return login.toLowerCase().endsWith("[bot]");
}

function buildComment(author: string, postedAt: string, entry: Record<string, unknown>): IssueComment {
  const raw = typeof entry.body === "string" ? entry.body : "";
  const editedAt = isoUtcSecond(entry.updated_at);
  const points = Array.from(raw);
  const cut = points.length > MAX_COMMENT_CHARS;
  return {
    author,
    postedAt,
    editedAt: editedAt !== null && editedAt !== postedAt ? editedAt : null,
    url: typeof entry.html_url === "string" ? entry.html_url : "",
    body: cut ? points.slice(0, MAX_COMMENT_CHARS).join("") : raw,
    fullLength: cut ? points.length : null,
  };
}
