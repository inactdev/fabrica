export { createForeman } from "./foreman.ts";
export type { ForemanOptions } from "./foreman.ts";
export { ForemanError } from "./errors.ts";
export type { ForemanErrorCode } from "./errors.ts";
export { DEFAULT_ATTEMPTS } from "./do.ts";
// Issue #123: the fast, synchronous validate-and-record half of
// answering/ruling, and the slow, round-running half - split so
// src/cli/ can run the first in the foreground and hand the second to a
// detached process. See answer.ts/verdict.ts for the full reasoning.
export { recordAnswerDecision, runRecordedAnswer } from "./answer.ts";
export type { AnswerDecision, AnswerDecisionOptions } from "./answer.ts";
// Issues #176/#175: the clarifying step's record side - which question a
// task is stopped on, which of its questions already have an answer, and
// the latest answer to each (the Client may correct one).
export { answeredQuestionsOf, answerFor, askedQuestionsOf, deriveBrief, renderAnswerRound } from "./questions.ts";
export type { AnswerRecord, AnswersGivenDetails } from "./questions.ts";
export type { AskedDetails, AskRejectedDetails, QuestionAutoAnsweredDetails } from "./ask.ts";
export { recordVerdictDecision, runRecordedFix } from "./verdict.ts";
// Issue #203: the Client's own stop - the record half only (the process
// half is src/cli/task-process.ts; see stop.ts's header for why).
export { recordStopDecision } from "./stop.ts";
export type { LastWorkerActivity, StoppedByOwnerDetails } from "./stop.ts";
export { DEFAULT_CHECK_COMMAND } from "./resolve-check.ts";
export { finalMessageFor } from "./pr-body.ts";
export type { ClosesIssue, FinalMessageForCommit } from "./pr-body.ts";
// Issue #316: a project whose pull request body is its repository's own
// template. `fabrica doctor` reads the template too, to say on that
// project's line whether there is one to render into.
export { readPullRequestTemplate, renderIntoTemplate, PULL_REQUEST_TEMPLATE_PATH } from "./pr-template.ts";
// A rebase-only fix round appends its one section to the pull request's
// existing body instead of replacing it (rebase-only.ts), so what the
// pull request says is not always a render of the latest write-up.
export { publishedPullRequestMessage } from "./rebase-only.ts";
// The issue a task names, fetched once at registration and carried into
// every brief - the record file and the brief section, so a surface
// showing a task can show the issue it is the whole of.
export { ISSUE_BRIEF_HEADER, storedClosesIssue, taskIssueText, withIssueText } from "./task-issue.ts";
export type { IssueReader } from "./task-issue.ts";
export { DEFAULT_HEARTBEAT_INTERVAL_MS } from "./attempts.ts";
// One age formatter for every surface that shows one - it used to live
// in src/cli/render.ts, which the live view cannot import from.
export { formatAge } from "./age.ts";
// Where a delivered task's branch stands against origin's default
// branch, and the one wording `fabrica status` and the live view both
// mark it with - a local-refs-only git read that writes nothing.
export { baseStandingOf, describeBaseStanding, describeBaseStandingOf } from "./base-standing.ts";
export type { BaseStanding } from "./base-standing.ts";
export { readTranscript } from "./transcript.ts";
export { followTask } from "./follow.ts";
export type { TaskFollower, TaskProgress } from "./follow.ts";
export {
  fixRoundOf,
  eventsByTask,
  stateOf,
  deliveryOf,
  deliveredBranchOf,
  deliveredFingerprintOf,
  earlyStopKindOf,
  passFingerprintsOf,
  priorPassFingerprints,
  readerFailureCount,
} from "./queries.ts";
// The change fingerprint (`git patch-id` of a pass's own diff against
// its merge-base with origin's default branch) and the one wording
// `fabrica status`, `fabrica log` and `delivery.md` all show for it.
export { describeFingerprint, shortPatchId } from "./fingerprint.ts";
export type { ChangeFingerprint, DeliveryStamp, FingerprintMatch, PassFingerprint } from "./fingerprint.ts";
export { capsActive } from "./caps.ts";
// What a worker box is allowed to reach for one task (issue #186) - read
// here by anything that calls a brain outside a production round, e.g.
// src/quiz's re-check (`withTaskNetwork` needs the same policy a round
// would have run under).
export { networkPolicyFor } from "./network-policy.ts";
export {
  costFromTranscript,
  daySpend,
  describeTaskCost,
  describeUnmeasured,
  formatUsd,
  hasAttempts,
  SPEND_UNKNOWN_LINE,
  taskSpend,
  unmeasuredSpend,
} from "./spend.ts";
export { requireGitRoot } from "./task-failure.ts";
// Issue #199: one retry on a dropped model call, on the same model,
// recorded. Exported for the one model call Fabrica makes outside a
// production round (src/quiz's re-check), which is as droppable as any
// other and gets the same single retry.
export { transportFailureReason, withTransportRetry, TRANSPORT_RETRY_WAIT_MS } from "./transport-retry.ts";
export type { ModelCall, TransportRetryDetails } from "./transport-retry.ts";
// Issue #189's pause rule: the thresholds, the readings, and the
// wording `fabrica status` and the review page both show.
export {
  describeMeters,
  formatPercent,
  latestMeterReading,
  meterPauseOf,
  METER_READING_MAX_AGE_MS,
  pauseRuleFor,
  refusalFor,
  standingOf,
} from "./meters.ts";
export type { MeterPausedDetails, MeterRefusedDetails, MeterStanding } from "./meters.ts";
// Issue #184: which model a task asked for, which one ran, and the one
// wording `fabrica status`, `fabrica log` and the live view all show.
export {
  describeDeclaration,
  describeModel,
  modelFromEvents,
  readModelChoice,
  receiptModel,
  resolveModelChoice,
} from "./model.ts";
export type { ModelChoice, ModelOnRecord, ModelSource } from "./model.ts";
// Issue #267: the two events a round appends for the checks the
// repository runs on its pull request, and the seam the GitHub read
// itself sits behind. The record writing is here, not in `src/ci/`, so no
// fake can skip it (see ci-checks.ts's own header).
export { concludedDetails, defaultChecksReader, finishedDetails, handToPullRequestChecks } from "./ci-checks.ts";
export type { ChecksReader, CiCheckConcludedDetails, CiChecksFinishedDetails } from "./ci-checks.ts";
// Issue #187: the GitHub token every call a task makes goes through,
// and the record entry that says so. The minting itself is
// src/githubapp's; this is the half that knows about tasks - which
// repository a project publishes to, and whose record the
// `"token-minted"` event lands on. `taskGithubCredential` is the one
// chokepoint (issue #314): the App, or this project's own token, never
// one as the other's fallback.
export {
  githubRepoOf,
  projectRepo,
  publishToken,
  readChecksScope,
  readIssueScope,
  recordingMinter,
  taskGithubCredential,
  taskTokenMinter,
  tokenMintedDetails,
} from "./github-token.ts";
export type { ProjectTokenUsedDetails, TaskGithubCredential, TokenMintedDetails } from "./github-token.ts";
