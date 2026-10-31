// The real program spawnDetachedResume's "fix" kind runs as the
// detached child (spawn-detached.ts spawns this, not verdict-command.ts
// directly - same split run-task-entry.ts/run-task.ts has for `fabrica
// do`). The parent already validated the ruling and recorded it
// (recordVerdictDecision, called synchronously in verdict-command.ts
// before this is ever spawned) - this only has to run the fix round
// itself (runRecordedFix, src/foreman/verdict.ts), which re-derives
// everything it needs - project, baseCommit, prior receipts, the note -
// from recordHome/taskId alone.

import { defaultBrainAdapter, machineImageForTask, readModelChoice, runRecordedFix } from "../index.ts";
import { prefixTaskLog } from "./task-log.ts";
import { writeTaskPidFile } from "./task-process.ts";

const setLogTaskId = prefixTaskLog();

const [, , recordHome, taskId] = process.argv;
setLogTaskId(taskId);

if (recordHome === undefined || taskId === undefined) {
  console.error(
    `fabrica (detached verdict runner): expected <recordHome> <taskId>, got ${process.argv.length - 2} argument(s).`
  );
  process.exit(1);
}

// Issue #203's `stop`: this process is the one running the task's round
// from here on, and is the only party that knows its own pid.
writeTaskPidFile(recordHome, taskId);

// Issue #184: same as answer-entry.ts - a fix round runs the model the
// task was registered with, read back off its own record.
const declaredModel = readModelChoice(recordHome, taskId).declaredModel ?? undefined;

// Issue #322: and in the same image, re-derived the same way - a fix
// round must not be written in a different box from the round it fixes.
const image = machineImageForTask(recordHome, taskId)?.image;

try {
  await runRecordedFix(recordHome, taskId, { brain: defaultBrainAdapter(recordHome, { model: declaredModel, image }) });
} catch (err) {
  console.error(`fabrica verdict: fix round for "${taskId}" failed: ${(err as Error).message}`);
  process.exit(1);
}
