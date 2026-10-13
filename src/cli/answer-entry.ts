// The real program spawnDetachedResume's "answer" kind runs as the
// detached child (spawn-detached.ts spawns this, not answer-command.ts
// directly - same split run-task-entry.ts/run-task.ts has for `fabrica
// do`). The parent already validated the answer and recorded it
// (recordAnswerDecision, called synchronously in answer-command.ts
// before this is ever spawned) - this only has to run the round itself
// (runRecordedAnswer, src/foreman/answer.ts), which re-derives
// everything it needs from recordHome/taskId alone.

import { defaultBrainAdapter, runRecordedAnswer } from "../index.ts";
import { prefixTaskLog } from "./task-log.ts";

const setLogTaskId = prefixTaskLog();

const [, , recordHome, taskId] = process.argv;
setLogTaskId(taskId);

if (recordHome === undefined || taskId === undefined) {
  console.error(
    `fabrica (detached answer runner): expected <recordHome> <taskId>, got ${process.argv.length - 2} argument(s).`
  );
  process.exit(1);
}

try {
  await runRecordedAnswer(recordHome, taskId, { brain: defaultBrainAdapter(recordHome) });
} catch (err) {
  console.error(`fabrica answer: resuming "${taskId}" failed: ${(err as Error).message}`);
  process.exit(1);
}
