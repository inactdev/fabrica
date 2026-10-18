// The real program spawnDetachedResume's "fix" kind runs as the
// detached child (spawn-detached.ts spawns this, not verdict-command.ts
// directly - same split run-task-entry.ts/run-task.ts has for `fabrica
// do`). The parent already validated the ruling and recorded it
// (recordVerdictDecision, called synchronously in verdict-command.ts
// before this is ever spawned) - this only has to run the fix round
// itself (runRecordedFix, src/foreman/verdict.ts), which re-derives
// everything it needs - project, baseCommit, prior receipts, the note -
// from recordHome/taskId alone.

import { defaultBrainAdapter, runRecordedFix } from "../index.ts";
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

try {
  await runRecordedFix(recordHome, taskId, { brain: defaultBrainAdapter(recordHome) });
} catch (err) {
  console.error(`fabrica verdict: fix round for "${taskId}" failed: ${(err as Error).message}`);
  process.exit(1);
}
