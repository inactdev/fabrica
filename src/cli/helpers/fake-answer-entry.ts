// Test-only stand-in for answer-entry.ts: same argv contract
// (<recordHome> <taskId>), but runs against fakeBrain instead of the
// real default adapter, so answer-command tests can exercise the real
// spawn-then-detach mechanism as a real separate process without ever
// invoking a real coding agent - same shape as
// fake-run-task-entry.ts for `fabrica do`.

import { fakeBrain } from "../../brain/helpers/fake-brain.ts";
import { fixtureInspector } from "../../../contract/helpers/fake-inspector.ts";
import { fixtureCheckBox } from "../../../contract/helpers/fake-check-box.ts";
import { runRecordedAnswer } from "../../index.ts";
import { prefixTaskLog } from "../task-log.ts";

const setLogTaskId = prefixTaskLog();

const [, , recordHome, taskId] = process.argv;
setLogTaskId(taskId);

try {
  await runRecordedAnswer(recordHome, taskId, {
    brain: fakeBrain(),
    inspector: fixtureInspector(),
    checkBox: fixtureCheckBox().box,
  });
} catch (err) {
  console.error(`fake-answer-entry: ${(err as Error).message}`);
  process.exit(1);
}
