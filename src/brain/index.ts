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
export { cliReaderFor, findCommandOnPath, CLI_READER_VENDOR } from "./adapters/cli-reader.ts";
export type { CliReaderRequest, CliReaderVendor, CommandLookup } from "./adapters/cli-reader.ts";
export { isModelName, MODEL_TRANSCRIPT_KIND, UNKNOWN_MODEL } from "./model.ts";
export { registerLiveTranscriptListener } from "./live-transcript.ts";
export { probeRelayHealth, registerRelayHealthProbe } from "./relay-health.ts";
export type { RelayHealthProbe } from "./relay-health.ts";
export { pauseWorker, readMeters, registerMeterSource } from "./meters.ts";
export type { MeterReading, MeterSource } from "./meters.ts";
export { currentTaskNetwork, withTaskNetwork } from "./task-network.ts";
export type { TaskNetworkPolicy } from "./task-network.ts";
export {
  installedCliVersionIn,
  pinnedCliVersion,
  probeWorkerToken,
  readImageStamp,
  workerCliVersionStatus,
  workerImageBuild,
  workerImageStatus,
  workerTokenStatus,
  DOCKERFILE_STAMP_LABEL,
  WORKER_CLI_LABEL,
  WORKER_IMAGE_LABEL,
} from "./adapters/doctor-checks.ts";
export type { ImageCommand } from "./adapters/doctor-checks.ts";
// The per-project machine image seam (src/projectimage/, issue #322):
// the layer Fabrica puts on top of a project's own check image, and the
// shared image a project with no such file keeps. The CLI, its version
// and the Node it runs on are all named inside the adapter directory;
// everything downstream only ever asks for the text.
export { DEFAULT_MACHINE_IMAGE } from "./adapters/index.ts";
export {
  finalStageUser,
  machineDockerfile,
  machineLayer,
  pinnedMachineNodeVersion,
  MACHINE_CLI_PATH,
  MACHINE_NODE_DIR,
  MACHINE_STAMP_ARG,
} from "./adapters/machine-layer.ts";
export type { BoxCheckResult, CheckBox } from "./check-box.ts";
