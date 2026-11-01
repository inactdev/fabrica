export { GitHubError } from "./errors.ts";
export type { GitHubErrorCode } from "./errors.ts";
export {
  formatIssueRef,
  parseIssueArg,
  parseStoredIssue,
  sameRepo,
  ISSUE_ARG_FORMS,
} from "./issue-ref.ts";
export type { IssueRef, IssueRequest } from "./issue-ref.ts";
export {
  fetchIssue,
  githubIssueSource,
  GITHUB_API_ROOT,
  GITHUB_API_VERSION,
  MAX_ISSUE_BYTES,
} from "./fetch-issue.ts";
// The shared pieces of one REST call, for a reader outside this module
// that must send the same headers and read an error body the same way
// (src/projecttoken/gh-push.ts's publish check) - never a second copy of
// either.
export { apiMessage, githubHeaders } from "./api.ts";
export type { FetchedIssue, GithubIssueSourceOptions, HttpFetch, IssueSource } from "./fetch-issue.ts";
export {
  fetchIssueComments,
  COMMENTS_PER_PAGE,
  MAX_COMMENT_CHARS,
  MAX_COMMENT_PAGES,
} from "./fetch-comments.ts";
export type { IssueComment, IssueComments, OmittedComment } from "./fetch-comments.ts";
