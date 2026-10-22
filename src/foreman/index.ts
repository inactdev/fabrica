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
export { recordVerdictDecision, runRecordedFix } from "./verdict.ts";
// Issue #203: the Client's own stop - the record half only (the process
// half is src/cli/task-process.ts; see stop.ts's header for why).
export { recordStopDecision } from "./stop.ts";
export type { LastWorkerActivity, StoppedByOwnerDetails } from "./stop.ts";
export { DEFAULT_CHECK_COMMAND } from "./resolve-check.ts";
export { finalMessageFor } from "./pr-body.ts";
export type { FinalMessageForCommit } from "./pr-body.ts";
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
export { fixRoundOf, eventsByTask, stateOf, deliveryOf, deliveredBranchOf, earlyStopKindOf } from "./queries.ts";
export { capsActive } from "./caps.ts";
export {
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
