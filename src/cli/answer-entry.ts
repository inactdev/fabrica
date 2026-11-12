// The real program spawnDetachedResume's "answer" kind runs as the
// detached child (spawn-detached.ts spawns this, not answer-command.ts
// directly - same split run-task-entry.ts/run-task.ts has for `fabrica
// do`). The parent already validated the answer and recorded it
// (recordAnswerDecision, called synchronously in answer-command.ts
// before this is ever spawned) - this only has to run the round itself
// (runRecordedAnswer, src/foreman/answer.ts), which re-derives
// everything it needs from recordHome/taskId alone.

import { defaultBrainAdapter, readModelChoice, recordTaskFailure, runRecordedAnswer } from "../index.ts";
import { requireMachineImageForTask } from "./machine-image.ts";
import { prefixTaskLog } from "./task-log.ts";
import { writeTaskPidFile } from "./task-process.ts";

const setLogTaskId = prefixTaskLog();

const [, , recordHome, taskId] = process.argv;
setLogTaskId(taskId);

if (recordHome === undefined || taskId === undefined) {
  console.error(
    `fabrica (detached answer runner): expected <recordHome> <taskId>, got ${process.argv.length - 2} argument(s).`
  );
  process.exit(1);
}

// Issue #203's `stop`: this process is the one running the task's round
// from here on, and is the only party that knows its own pid.
writeTaskPidFile(recordHome, taskId);

// Issue #184: this round's worker is built with the model the task was
// registered with (`model.json`), so a resumed round runs the model the
// Client asked for rather than the default - re-derived from the record
// like everything else this process needs.
const declaredModel = readModelChoice(recordHome, taskId).declaredModel ?? undefined;

// Issue #322: the same image this task's first round ran in, re-derived
// from the project on its own record rather than threaded across the
// process boundary - the same way the model above is. Built here if
// Fabrica's own layer has moved since (a merge makes every project's
// image stale at once), and refused here - on the record, as this task's
// own failure - if that build fails, so this round is never started in a
// box that is not there. Before `runRecordedAnswer`, so a refusal costs
// no round; the answer itself is already recorded either way, and the
// round stays resumable.
let image: string | undefined;
try {
  image = await requireMachineImageForTask(recordHome, taskId, { onOutput: (line) => console.error(line) });
} catch (err) {
  recordTaskFailure(recordHome, taskId, err);
  console.error(`fabrica answer: resuming "${taskId}" failed: ${(err as Error).message}`);
  process.exit(1);
}

try {
  await runRecordedAnswer(recordHome, taskId, { brain: defaultBrainAdapter(recordHome, { model: declaredModel, image }) });
} catch (err) {
  // Issue #353, same shape as verdict-fix-entry.ts: whatever
  // `runRecordedAnswer` does before it wraps the round in
  // `recordingFailure` was reaching only this line and
  // <recordHome>/cli.log. A failure already recorded is not recorded
  // twice.
  recordTaskFailure(recordHome, taskId, err);
  console.error(`fabrica answer: resuming "${taskId}" failed: ${(err as Error).message}`);
  process.exit(1);
}
