// src/ci/ - what the repository's own CI said about the pull request
// Fabrica's work is on (issue #267).
//
// Read-only: GET requests to GitHub's REST API and nothing else. Fabrica
// runs no project check on the host (issue #64's ruling) and this module
// changes nothing about that - it reads results that already exist,
// caused by Inspector's own push. Which checks exist stays the
// repository's business; nothing here names a check, a workflow or a
// provider.
//
// See README.md for the whole shape and the reasoning behind each bound.

export { parsePullRequestUrl } from "./pull-request.ts";
export { createGithubReader, GITHUB_API_BASE, GITHUB_API_VERSION, REQUEST_TIMEOUT_MS } from "./github.ts";
export type { FetchLike, GithubReader, GithubReaderOptions } from "./github.ts";
export { CiError } from "./errors.ts";
export type { CiErrorCode } from "./errors.ts";
export { isRedConclusion, isUnresolvedCheckRunStatus, isUnresolvedCommitStatusState } from "./conclusions.ts";
export { readChecks, readHeadSha, PAGE_SIZE } from "./read.ts";
export type { ChecksSnapshot } from "./read.ts";
export { attachLogTails, tailOf, MAX_LOG_TAIL_BYTES, MAX_LOGS_FETCHED } from "./logs.ts";
export {
  pollPullRequestChecks,
  DEFAULT_CHECKS_APPEAR_MS,
  DEFAULT_CHECKS_POLL_INTERVAL_MS,
  DEFAULT_CHECKS_WAIT_MS,
} from "./poll.ts";
export type { PollOptions } from "./poll.ts";
export { CHECKS_LABEL, checksCorrection, checksOutputForWorker, isRedReport, summarizeChecks } from "./report.ts";
export { readPullRequestChecks } from "./checks.ts";
export type { ReadChecksOptions } from "./checks.ts";
export type {
  ChecksReport,
  ChecksVerdict,
  CheckSource,
  ConcludedCheck,
  PullRequestRef,
  UnresolvedCheck,
} from "./types.ts";
