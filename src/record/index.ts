export { recordPath, appendEvent } from "./append.ts";
export { readEvents, readEventsForTask } from "./read.ts";
export { createLineTail } from "./tail.ts";
export type { LineTail } from "./tail.ts";
export {
  registerTask,
  taskDir,
  taskFilePath,
  writeTaskFile,
  appendTaskFile,
  readTaskFile,
} from "./tasks.ts";
export { generateCandidateId, claimTaskId, TASK_ID_PATTERN } from "./ids.ts";
export { RecordError } from "./errors.ts";
export type { RecordErrorCode } from "./errors.ts";
export type { FabricaEvent, NewFabricaEvent, FabricaEventName, TaskFile } from "./types.ts";
