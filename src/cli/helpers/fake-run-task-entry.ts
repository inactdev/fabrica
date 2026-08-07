// Test-only stand-in for run-task-entry.ts: same argv contract
// (<recordHome> <projectPath> <taskText>), but runs against fakeBrain
// instead of the real default adapter, so spawn-detached and do-command
// tests can exercise the real spawn-then-discover mechanism as a real
// separate process without ever invoking a real coding agent.
//
// A taskText containing ASK_ME_SOMETHING makes the fake brain ask a
// clarifying question (issue #8) instead of proceeding straight to
// work - there's no other channel to configure this fake across the
// process boundary, so the marker rides in the one string this process
// already receives, the same way the reference adapter's own fake CLI
// fixture keys its scenarios off `brief`.
import { fakeBrain } from "../../brain/helpers/fake-brain.ts";
import { runTask } from "../run-task.ts";

const [, , recordHome, projectPath, taskText] = process.argv;

try {
  const askQuestions = taskText.includes("ASK_ME_SOMETHING")
    ? ["What database should this use?", "Should it support multi-tenancy?"]
    : undefined;
  await runTask(recordHome, projectPath, taskText, fakeBrain({ askQuestions }));
} catch (err) {
  console.error(`fake-run-task-entry: ${(err as Error).message}`);
  process.exit(1);
}
