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
export { fixRoundOf } from "./foreman/index.ts";
// Issue #123: the CLI's seam for detaching `fabrica answer`/`fabrica
// verdict fix` - see those two modules' own comments for why the round
// itself is re-derived from the record rather than threaded through.
export { recordAnswerDecision, runRecordedAnswer } from "./foreman/index.ts";
export { recordVerdictDecision, runRecordedFix } from "./foreman/index.ts";
export { DEFAULT_HEARTBEAT_INTERVAL_MS } from "./foreman/index.ts";
export { readTranscript, eventsByTask, stateOf } from "./foreman/index.ts";
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
export type { TaskFollower, TaskProgress } from "./foreman/index.ts";
export type { TranscriptEntry } from "../contract/surface.ts";
export type {
  Delivery,
  FabricaTask,
  FabricaEvent,
  FabricaEventName,
  Inspection,
  Inspector,
} from "./inspector/types.ts";
export { validateDelivery, diffFiles, DeliveryError } from "./delivery/index.ts";
export type { DeliveryErrorCode } from "./delivery/index.ts";

// The brain socket: a CLI never picks an adapter by name (CONTRACT rule
// 8) - it asks for whichever one v1 wires in by default.
export { defaultBrainAdapter } from "./brain/index.ts";
// `fabrica doctor`'s machine checks (src/cli/doctor-command.ts).
export { probeWorkerToken, workerImageStatus, workerTokenStatus } from "./brain/index.ts";
export { githubTokenStatus, inspectorBranchStatus } from "./inspector/index.ts";
export { requireGitRoot } from "./foreman/index.ts";
export type { Brain, Caps } from "../contract/surface.ts";
export type { BoxCheckResult, CheckBox } from "./brain/index.ts";

// Config: the record home's project registry and caps (SPEC.md
// "Config"), needed by the CLI to resolve `--project <path-or-name>`
// before it ever calls createForeman.
export { loadConfig, projectsTomlPath, requireProject } from "./config/index.ts";
export { ConfigError } from "./config/index.ts";
export type { ConfigErrorCode, ProjectConfig, FabricaConfig, CheckedProjectConfig } from "./config/index.ts";

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
export { createLineTail, recordPath, readTaskFile } from "./record/index.ts";
export type { LineTail, TaskFile } from "./record/index.ts";
