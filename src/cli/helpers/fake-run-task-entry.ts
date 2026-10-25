// Test-only stand-in for run-task-entry.ts: same argv contract
// (task-entry-args.ts), but runs against fakeBrain
// instead of the real default adapter, so spawn-detached and do-command
// tests can exercise the real spawn-then-discover mechanism as a real
// separate process without ever invoking a real coding agent.
//
// A taskText containing ASK_ME_SOMETHING makes the fake brain ask a
// clarifying question (issue #8) instead of proceeding straight to
// work; one containing ASK_FAILS_SOMETHING makes ask() itself throw
// (issue #8 follow-up - stands in for the reference adapter's
// documented credential gap, today's live path for this failure) -
// there's no other channel to configure this fake across the process
// boundary, so the marker rides in the one string this process already
// receives, the same way the reference adapter's own fake CLI fixture
// keys its scenarios off `brief`.
import { fakeBrain } from "../../brain/helpers/fake-brain.ts";
import { fixtureInspector } from "../../../contract/helpers/fake-inspector.ts";
import { fixtureCheckBox } from "../../../contract/helpers/fake-check-box.ts";
import { fakeIssueReader } from "../../foreman/helpers/fake-issue-reader.ts";
import { runTask } from "../run-task.ts";
import { prefixTaskLog } from "../task-log.ts";
import { parseTaskEntryArgs } from "../task-entry-args.ts";

const setLogTaskId = prefixTaskLog();

const { recordHome, projectPath, taskText, issue, model } = parseTaskEntryArgs(process.argv);

try {
  const askQuestion = taskText.includes("ASK_ME_SOMETHING")
    ? { question: "What database should this use?", options: ["Postgres", "SQLite"] }
    : undefined;
  const askError = taskText.includes("ASK_FAILS_SOMETHING")
    ? new Error("simulated: the brain is unreachable (no credential configured)")
    : undefined;
  // Neither the real Inspector nor the real worker's box: fakes that read
  // the fixture's check.sh to answer, and run nothing.
  // Issue #184: a declared model reaches the fake brain as its own
  // `model` label, so a `--model` run through the real detached
  // mechanism records the declaration AND an actual model, the same way
  // the reference adapter's would.
  await runTask(recordHome, projectPath, taskText, fakeBrain({ askQuestion, askError, ...(model ? { model } : {}) }), {
    inspector: fixtureInspector(),
    checkBox: fixtureCheckBox().box,
    onTaskRegistered: setLogTaskId,
    issue,
    // Neither the real GitHub nor a real token: a fixture issue, for the
    // same reason the Inspector and the box above are fakes.
    issueReader: fakeIssueReader().reader,
    model,
  });
} catch (err) {
  console.error(`fake-run-task-entry: ${(err as Error).message}`);
  process.exit(1);
}
