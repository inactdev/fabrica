// GitHubError: every refusal this module produces carries a `code` for
// callers that need to branch on it, and a `message` written to be shown
// to the Client verbatim - src/foreman wraps it in a ForemanError whose
// message is this one, unchanged, so the cause the Client reads is the
// one GitHub actually gave.
//
// No message here ever carries the token: the only secret this module
// handles is an `Authorization` header value, and a refusal naming it
// would put it on the record (`task-failed`'s own details) and in the
// Client's terminal.

export type GitHubErrorCode =
  /** The `--issue` value is not a number, `owner/repo#N`, or a GitHub
   * issue URL. */
  | "issue-ref-unparsable"
  /** A plain `--issue N` has no repository to resolve against: the
   * project has no `origin`, its URL names no owner/repo, or that
   * remote is not on github.com. */
  | "no-origin-repo"
  /** GitHub answered 404 (or 410 for a deleted one): no such issue, or
   * none this token may read. */
  | "issue-not-found"
  /** The issue was transferred to another repository (301). */
  | "issue-moved"
  /** The number names a pull request. Every pull request is an issue to
   * GitHub's API, but not to a task. */
  | "issue-is-pull-request"
  /** GitHub could not be reached, or answered something else entirely. */
  | "issue-fetch-failed"
  /** GitHub answered, but not with an issue this module can read. */
  | "issue-unreadable"
  /** Past `MAX_ISSUE_BYTES`: the Client's own ruling is that an issue is
   * carried verbatim and in full or not at all, so an oversized one is
   * refused rather than truncated (see fetch-issue.ts). */
  | "issue-too-large";

export class GitHubError extends Error {
  readonly code: GitHubErrorCode;

  constructor(code: GitHubErrorCode, message: string) {
    super(message);
    this.name = "GitHubError";
    this.code = code;
  }
}
