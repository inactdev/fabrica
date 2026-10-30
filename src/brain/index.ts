export type {
  Brain,
  BrainAskResult,
  BrainWorkOptions,
  BrainWorkResult,
  TranscriptEntry,
  WorkerWriteup,
  WriteupQuizEntry,
} from "./types.ts";
export type { AskQuestion, RecordedQuestion } from "./ask-shape.ts";
export {
  ASK_MAX_OPTIONS,
  ASK_MIN_OPTIONS,
  ASK_RESHAPE_LIMIT,
  ASK_SHAPE_NOTICE,
  askShapeProblem,
  deriveQuestionId,
  isOtherOption,
  OTHER_OPTION,
  QUESTION_ID_PATTERN,
  recordQuestion,
  withAskRejection,
  withOtherOption,
} from "./ask-shape.ts";
export {
  quizEntriesOf,
  quizProblem,
  WRITEUP_FIELDS,
  WRITEUP_OPTIONAL_STRING_FIELDS,
  WRITEUP_QUIZ_LENGTH,
  WRITEUP_STRING_FIELDS,
  WRITEUP_TITLE_MAX_LENGTH,
} from "./writeup.ts";
export { defaultBrainAdapter, defaultCheckBox } from "./adapters/index.ts";
export type { BrainChoice } from "./adapters/index.ts";
// The reviewer seam (src/reviewer/resolve.ts): which vendor the
// selected Worker belongs to, and the one credential file a reviewer's
// own key may be kept in alongside the Worker's.
export { brainEnvPath, brainEnvValue, workerVendor } from "./adapters/index.ts";
// The code reader seam (src/reader/resolve.ts): which `vendor =`
// spelling, if any, is served by a command on this host rather than by a
// key and an endpoint (issue #315). The name itself stays inside the
// adapter directory - everything downstream only ever asks.
export { cliReaderFor, CLI_READER_VENDOR } from "./adapters/cli-reader.ts";
export type { CliReaderRequest, CliReaderVendor } from "./adapters/cli-reader.ts";
export { isModelName, MODEL_TRANSCRIPT_KIND, UNKNOWN_MODEL } from "./model.ts";
export { registerLiveTranscriptListener } from "./live-transcript.ts";
export { probeRelayHealth, registerRelayHealthProbe } from "./relay-health.ts";
export type { RelayHealthProbe } from "./relay-health.ts";
export { pauseWorker, readMeters, registerMeterSource } from "./meters.ts";
export type { MeterReading, MeterSource } from "./meters.ts";
export { currentTaskNetwork, withTaskNetwork } from "./task-network.ts";
export type { TaskNetworkPolicy } from "./task-network.ts";
export { probeWorkerToken, workerCliVersionStatus, workerImageStatus, workerTokenStatus } from "./adapters/doctor-checks.ts";
export type { BoxCheckResult, CheckBox } from "./check-box.ts";
