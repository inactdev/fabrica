// The actual program the detached child process runs (spawn-detached.ts
// spawns this file, not run-task.ts directly). Deliberately thin and
// untested on its own - everything worth testing is in run-task.ts,
// which this only wires up: read argv, pick the one real brain adapter
// v1 ships (CONTRACT rule 8 - nothing outside src/brain/adapters/ may
// choose *which* adapter, but wiring in "the default one" is fine),
// run the task, and make sure a thrown error is at least visible in
// this process's own stdio (spawn-detached.ts redirects that to
// <recordHome>/cli.log, since there is no terminal left to print to by
// the time this can fail).

import { defaultBrainAdapter } from "../index.ts";
import { runTask } from "./run-task.ts";

const [, , recordHome, projectPath, taskText] = process.argv;

if (recordHome === undefined || projectPath === undefined || taskText === undefined) {
  console.error(
    `fabrica (detached runner): expected <recordHome> <projectPath> <taskText>, got ` +
      `${process.argv.length - 2} argument(s).`
  );
  process.exit(1);
}

try {
  await runTask(recordHome, projectPath, taskText, defaultBrainAdapter());
} catch (err) {
  console.error(`fabrica do: task on "${projectPath}" failed: ${(err as Error).message}`);
  process.exit(1);
}
