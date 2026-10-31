// The actual program the detached child process runs (spawn-detached.ts
// spawns this file, not run-task.ts directly). Deliberately thin and
// untested on its own - everything worth testing is in run-task.ts and
// task-entry-args.ts, which this only wires up: read argv, pick the one
// real brain adapter v1 ships (CONTRACT rule 8 - nothing outside
// src/brain/adapters/ may choose *which* adapter, but wiring in "the
// default one" is fine), run the task, and make sure a thrown error is
// at least visible in this process's own stdio (spawn-detached.ts
// redirects that to <recordHome>/cli.log, since there is no terminal
// left to print to by the time this can fail).

import { defaultBrainAdapter } from "../index.ts";
import { runTask } from "./run-task.ts";
import { prefixTaskLog } from "./task-log.ts";
import { parseTaskEntryArgs } from "./task-entry-args.ts";
import { writeTaskPidFile } from "./task-process.ts";

const setLogTaskId = prefixTaskLog();

let args: ReturnType<typeof parseTaskEntryArgs>;
try {
  args = parseTaskEntryArgs(process.argv);
} catch (err) {
  console.error(`fabrica (detached runner): ${(err as Error).message}`);
  process.exit(1);
}

// `issue`, `model` and `files` all travel as named flags
// (spawn-detached.ts), present only when `fabrica do` was given them.
// The issue is handed on as the text it arrived as: do-args.ts already
// proved it is one of the three spellings, and registration parses it in
// one place (src/foreman/task-issue.ts) rather than each process
// re-deriving a number here. The files arrive already absolute, for the
// same reason: do-args.ts resolved them against the terminal's own
// working directory, which this process does not share.
const { recordHome, projectPath, taskText, issue, model, files } = args;

try {
  // Issue #184: the declared model builds the worker here, and travels
  // on into doTask, which records it on the task and on every receipt.
  await runTask(recordHome, projectPath, taskText, defaultBrainAdapter(recordHome, { model }), {
    // The task id does not exist until registration, and this process
    // is the only party that knows its own pid - so the pid file
    // (issue #203's `stop`) is written here, at the first moment both
    // halves are known.
    onTaskRegistered: (taskId) => {
      setLogTaskId(taskId);
      writeTaskPidFile(recordHome, taskId);
    },
    issue,
    model,
    files,
  });
} catch (err) {
  console.error(`fabrica do: task on "${projectPath}" failed: ${(err as Error).message}`);
  process.exit(1);
}
