// Fabrica's single public entry point (issue #45). contract/*.test.ts, and
// the CLI (src/cli/, issue #47), import the real implementation from here
// rather than reaching into src/foreman or any other internal module
// directly — so internal restructuring never touches the ratified
// contract tests' imports.

export { createForeman } from "./foreman/index.ts";
export type { ForemanOptions } from "./foreman/index.ts";
export type { Foreman } from "./inspector/types.ts";
export { ForemanError } from "./foreman/index.ts";
export type { ForemanErrorCode } from "./foreman/index.ts";
export { DEFAULT_ATTEMPTS } from "./foreman/index.ts";
export { DEFAULT_CHECK_COMMAND } from "./foreman/index.ts";
export { finalMessageFor } from "./foreman/index.ts";
export type { FinalMessageForCommit } from "./foreman/index.ts";
export { fixRoundOf } from "./foreman/index.ts";
// Issue #123: the CLI's seam for detaching `fabrica answer`/`fabrica
// verdict fix` - see those two modules' own comments for why the round
// itself is re-derived from the record rather than threaded through.
export { recordAnswerDecision, runRecordedAnswer } from "./foreman/index.ts";
export { recordVerdictDecision, runRecordedFix } from "./foreman/index.ts";
// Issue #203: the review page's one new write - recording the Client's
// decision to stop a task. Signaling the worker's own process is a
// separate, CLI-layer step (src/cli/task-process.ts).
export { recordStopDecision } from "./foreman/index.ts";
export type { LastWorkerActivity, StoppedByOwnerDetails } from "./foreman/index.ts";
export { DEFAULT_HEARTBEAT_INTERVAL_MS } from "./foreman/index.ts";
export { readTranscript, eventsByTask, stateOf, deliveryOf, deliveredBranchOf, earlyStopKindOf } from "./foreman/index.ts";
// The "behind origin/<branch>, a fix will rebase" marker both
// `fabrica status` and the live view show on a delivered task, plus the
// read-only git check behind it and the age formatter its label uses.
// One implementation for both surfaces: the live view reaches Fabrica
// only through this file, so a label built under src/cli/ would have to
// be hand-duplicated there to be shown at all.
export { baseStandingOf, describeBaseStanding, describeBaseStandingOf, formatAge } from "./foreman/index.ts";
export type { BaseStanding } from "./foreman/index.ts";
export { followTask } from "./foreman/index.ts";
// Rule 10's ledger, for `fabrica status` and `fabrica cost` (issue #11).
export {
  capsActive,
  daySpend,
  describeTaskCost,
  describeUnmeasured,
  formatUsd,
  hasAttempts,
  SPEND_UNKNOWN_LINE,
  taskSpend,
  unmeasuredSpend,
} from "./foreman/index.ts";
// Issue #189's pause rule, for `fabrica status` and the live view's
// review page - both show the two subscription meters, and both read
// them from the same functions the rule itself decides with, so neither
// can show a number that disagrees with what gates new work.
export {
  describeMeters,
  formatPercent,
  latestMeterReading,
  meterPauseOf,
  METER_READING_MAX_AGE_MS,
  pauseRuleFor,
  refusalFor,
  standingOf,
} from "./foreman/index.ts";
export type { MeterPausedDetails, MeterRefusedDetails, MeterStanding } from "./foreman/index.ts";
export type { MeterReading } from "./brain/index.ts";
// Issue #184: the model a task asked for, the one that actually ran, and
// the single phrase every surface shows for the pair.
export {
  describeDeclaration,
  describeModel,
  modelFromEvents,
  readModelChoice,
  receiptModel,
  resolveModelChoice,
} from "./foreman/index.ts";
export type { ModelChoice, ModelOnRecord, ModelSource } from "./foreman/index.ts";
export { UNKNOWN_MODEL } from "./brain/index.ts";
export type { TaskFollower, TaskProgress } from "./foreman/index.ts";
export type { TranscriptEntry, WriteupQuizEntry } from "../contract/surface.ts";
// The write-up as every reader in src/ and every integration sees it:
// the ratified shape plus the one optional field a project's committed
// test map asks for (see src/brain/types.ts for why the widening lives
// there, not in the contract).
export type { WorkerWriteup } from "./brain/index.ts";
// A project's committed test map (src/testmap/): which tests cover which
// files, the report a delivery records about it, and the one phrase a
// `fabrica status` row shows. `fabrica tests-map` generates the file;
// src/cli/ reaches all of it through here, never into src/testmap
// directly.
export {
  describeTestMapNote,
  describeTestMapReport,
  generatedHeader,
  generateTestMap,
  readTestMap,
  TEST_MAP_FILENAME,
  testMapPath,
  writeTestMap,
} from "./testmap/index.ts";
// `TestMapError` deliberately stays inside src/: a malformed map reaches
// the CLI as the `ForemanError("test-map-unreadable")` a round refuses
// with, carrying src/testmap's own message, so nothing out here has to
// know this module has an error class of its own.
export type { TestMapReport } from "./testmap/index.ts";
// Issue #98: the write-up's quiz, as the live view reads it - one reader
// for "is there a showable quiz here", so every surface skips a
// quiz-less task the same way.
export { quizEntriesOf, WRITEUP_QUIZ_LENGTH } from "./brain/index.ts";
// The quiz as a thing with a memory (src/quiz/): every accepted task's
// questions, the repetition schedule derived from the Client's own
// right/wrong marks, the "may be outdated" mark a later accept leaves,
// and the re-check round that clears it. The live view and the CLI both
// reach all of it through here, never into src/quiz directly.
export {
  allQuizQuestions,
  describeInterval,
  onTaskAccepted,
  pendingRecheckCount,
  quizQuestionsForTask,
  QuizError,
  QUIZ_SESSION_GAP_MS,
  recordQuizAnswer,
  runQuizRecheck,
} from "./quiz/index.ts";
export type { QuizErrorCode, QuizQuestion, QuizQuestionStatus, QuizStanding } from "./quiz/index.ts";
export type {
  Delivery,
  FabricaTask,
  FabricaEvent,
  FabricaEventName,
  Inspection,
  Inspector,
  // Issue #189: the receipt every reader in src/ and every integration
  // uses - the contract's own shape plus the two subscription meters
  // and the "paused-by-meter" outcome (see src/inspector/types.ts for
  // why the widening lives there).
  Receipt,
} from "./inspector/types.ts";
export { validateDelivery, diffFiles, DeliveryError } from "./delivery/index.ts";
export type { DeliveryErrorCode } from "./delivery/index.ts";

// The brain socket: a CLI never picks an adapter by name (CONTRACT rule
// 8) - it asks for whichever one v1 wires in by default.
export { defaultBrainAdapter } from "./brain/index.ts";
// `fabrica doctor`'s machine checks (src/cli/doctor-command.ts).
export { probeWorkerToken, workerCliVersionStatus, workerImageStatus, workerTokenStatus } from "./brain/index.ts";
export { relayImageStatus } from "./relay/index.ts";
// The Docker networks tasks run on: what is still open
// (`fabrica doctor`'s leftover count) and the one command that clears
// the unused ones, named identically wherever the Client is told about
// them (src/containment/task-networks.ts, network-pools.ts).
export { listWorkerNetworks, NETWORK_PRUNE_COMMAND, WORKER_NETWORK_PREFIX } from "./containment/index.ts";
export type { WorkerNetwork } from "./containment/index.ts";
// Issue #267: what the repository's own checks said about the pull
// request. Only the label and the two event-detail shapes are exported -
// `fabrica status`/`watch` and the live view read the summary straight
// off the `"ci-checks-finished"` event rather than polling anything
// themselves, and nothing outside src/ci/ ever makes a GitHub call.
export { CHECKS_LABEL } from "./ci/index.ts";
export type { ChecksVerdict } from "./ci/index.ts";
export type { CiCheckConcludedDetails, CiChecksFinishedDetails } from "./foreman/index.ts";
export { inspectorBranchStatus } from "./inspector/index.ts";
// Issue #187: every GitHub call Fabrica makes - Inspector's push and
// pull request, the issue a task names, the checks on its pull request -
// uses a GitHub App token minted for one repository, with only that
// call's own permissions, and discarded afterwards. The Client's
// personal token is gone; `fabrica doctor`'s own line is what tells him
// whether the App is configured and installed, and warns while a
// personal token is still lying around.
export { githubAppStatus, GithubAppError } from "./githubapp/index.ts";
export type {
  GithubAppCheck,
  GithubAppErrorCode,
  MintPurpose,
  ProjectRepo,
  TokenMinter,
} from "./githubapp/index.ts";
// Which GitHub repository a registered project's pull requests go to,
// for the one caller that reports on every project at once
// (`fabrica doctor`) rather than minting for one.
export { githubRepoOf } from "./foreman/index.ts";
export type { TokenMintedDetails } from "./foreman/index.ts";
// Where `fabrica do --issue <N>` reads that issue from: the real GitHub
// by default, a fake in tests (src/foreman/helpers/fake-issue-reader.ts).
// src/cli/ only ever names the type - it never picks a source - and
// shares one parser for `--issue`'s three spellings, so the flag and
// registration can never disagree about which values are legal.
export { ISSUE_ARG_FORMS, parseIssueArg, GitHubError } from "./github/index.ts";
export type {
  FetchedIssue,
  GitHubErrorCode,
  IssueComment,
  IssueRef,
  IssueRequest,
  IssueSource,
  OmittedComment,
} from "./github/index.ts";
export type { IssueReader } from "./foreman/index.ts";
// Who judges a project's test changes, and the three grounds on which
// that cannot be settled - `fabrica do` refuses up front on all three.
export { resolveReviewer } from "./reviewer/index.ts";
export type { ResolvedReviewer, ReviewerResolution } from "./reviewer/index.ts";
// `fabrica update`'s Inspector step (src/cli/update-command.ts): the
// installed Inspector's own build, main's tip, how the two are ordered,
// and the one classifier doctor's inspector line branches on too, so
// neither can call a binary current that the other just replaced.
export {
  goInstallInspector,
  inspectorInstallCommand,
  inspectorVersionCheck,
  realInspectorVersionProbes,
  INSPECTOR_MODULE_PATH,
} from "./inspector/index.ts";
export type {
  CommitAncestry,
  InspectorBuild,
  InspectorVersionProbes,
  InspectorVersionState,
} from "./inspector/index.ts";
export { requireGitRoot } from "./foreman/index.ts";
export type { Brain, Caps, GateResult } from "../contract/surface.ts";
export type { BoxCheckResult, CheckBox } from "./brain/index.ts";

// Config: the record home's project registry and caps (SPEC.md
// "Config"), needed by the CLI to resolve `--project <path-or-name>`
// before it ever calls createForeman.
export { loadConfig, loadConfigOrProblem, projectsTomlPath, requireProject, DEFAULT_PAUSE_RULE } from "./config/index.ts";
export { ConfigError } from "./config/index.ts";
export type {
  ConfigErrorCode,
  ConfigProblem,
  PauseRule,
  ProjectConfig,
  FabricaConfig,
  CheckedProjectConfig,
  ReviewerConfig,
} from "./config/index.ts";

// `fabrica register` (src/cli/register-command.ts): the one command
// allowed to push, because it runs as the Client and only ever creates a
// branch for him to merge. `originSetup`/`notSetUpMessage` are also
// what `fabrica do`'s up-front gate refuses on: one look at origin's
// default branch answering both "is this set up at all" and "does it
// ask for its test changes judged" (`inspectorConfiguredOnOrigin` is
// the narrower, first question on its own).
// A repository with no `.inspector.json` that register wasn't told what
// to write one from gets a *proposal* instead, printed and never written
// (issue #114): RegisterProposalError is how that reaches the CLI, which
// has to put the document on stdout alone and the reasoning on stderr.
export {
  registerProject,
  proposeInspectorConfig,
  readProposalSignals,
  RegisterError,
  RegisterProposalError,
  inspectorConfiguredOnOrigin,
  notSetUpMessage,
  originSetup,
} from "./register/index.ts";
export type { OriginSetup } from "./register/index.ts";
export type {
  InspectorProposal,
  ProposalSignals,
  RegisterErrorCode,
  RegisterOptions,
  RegisterRequest,
  RegisterResult,
  RegisterTools,
} from "./register/index.ts";

// Off-the-books nets (issue #13), prevention half: recordBlockedEditAttempt
// is what `fabrica deny-and-log-edit` (src/cli/deny-and-log-edit-command.ts,
// the command a harness's session config wires its file-editing hook to)
// imports from here, the same way the CLI imports everything else it
// needs — never straight from src/offbooks/. (Issue #13 also specified a
// detection half; it was built, tested, then cut by Client ruling — see
// AGENTS.md.)
export { recordBlockedEditAttempt } from "./offbooks/index.ts";
export type { BlockedEditAttempt } from "./offbooks/index.ts";

// The record's read side: `fabrica verify-hook` (src/cli/) reads back the
// events an attempt should have produced, to prove it rather than assume it.
// (`eventsByTask` above is grouped by task; this is the flat, whole-record
// list `readEvents(...).length`/`.slice(...)` needs - a different shape,
// not a duplicate. `FabricaEvent` itself is already exported above.)
export { readEvents } from "./record/index.ts";
// The raw tail reader and task-file reader, for an external follower that
// needs the whole record rather than one task's slice of it (followTask,
// above, is scoped to a single taskId) - e.g. a tool that opens something
// per task as task-received events arrive, reusing the same byte-offset
// tail `fabrica watch` reads through rather than re-reading the file.
export { createLineTail, recordPath, readTaskFile, TASK_ID_PATTERN } from "./record/index.ts";
export type { LineTail, TaskFile } from "./record/index.ts";
