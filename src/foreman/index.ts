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
export { DEFAULT_CHECK_COMMAND } from "./resolve-check.ts";
export { DEFAULT_HEARTBEAT_INTERVAL_MS } from "./attempts.ts";
export { readTranscript } from "./transcript.ts";
export { followTask } from "./follow.ts";
export type { TaskFollower, TaskProgress } from "./follow.ts";
export { fixRoundOf, eventsByTask, stateOf } from "./queries.ts";
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
