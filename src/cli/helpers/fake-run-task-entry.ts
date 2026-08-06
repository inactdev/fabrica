// Test-only stand-in for run-task-entry.ts: same argv contract
// (<recordHome> <projectPath> <taskText>), but runs against fakeBrain
// instead of the real default adapter, so spawn-detached and do-command
// tests can exercise the real spawn-then-discover mechanism as a real
// separate process without ever invoking a real coding agent.

import { fakeBrain } from "../../brain/helpers/fake-brain.ts";
import { runTask } from "../run-task.ts";

const [, , recordHome, projectPath, taskText] = process.argv;

try {
  await runTask(recordHome, projectPath, taskText, fakeBrain());
} catch (err) {
  console.error(`fake-run-task-entry: ${(err as Error).message}`);
  process.exit(1);
}
