// runAnswerCommand end to end - the CLI's own argument parsing,
// config-free record home, and message wording. Resuming always wakes a
// worker (unlike verdict's accept/wrong), and (issue #123) this command
// now returns before that round finishes: the answer is validated and
// recorded synchronously, right here, but the round itself is handed to
// a detached process (the same mechanism `fabrica do` uses), run here
// against a fake brain via `entryScript`, the same shape
// do-command.test.ts uses.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createForeman } from "../index.ts";
import { fakeBrain } from "../brain/helpers/fake-brain.ts";
import { makeFixtureRepo } from "../../contract/helpers/fixture.ts";
import { runAnswerCommand } from "./answer-command.ts";
import { fixtureInspector } from "../../contract/helpers/fake-inspector.ts";
import { readEventsForTask } from "../record/index.ts";

const FAKE_ANSWER_ENTRY = fileURLToPath(new URL("./helpers/fake-answer-entry.ts", import.meta.url));

function tempRecordHome(): string {
  return mkdtempSync(join(tmpdir(), "fabrica-cli-answer-command-"));
}

function captureIo() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, stdout: (l: string) => out.push(l), stderr: (l: string) => err.push(l) };
}

// Issue #123's own definition of done for this command: it returns
// before the resumed round finishes, and the round still completes and
// delivers in the background.
test("runAnswerCommand: returns before the resumed round finishes, and the round still delivers", async () => {
  const recordHome = tempRecordHome();
  const task = await createForeman({ recordHome, inspector: fixtureInspector() }).do("build me an app", {
    project: makeFixtureRepo("exit 0"),
    brain: fakeBrain({ askQuestions: ["What database should this use?"] }),
  });
  assert.equal(task.state, "asking");
  const io = captureIo();

  const started = Date.now();
  const code = await runAnswerCommand([task.id, "-m", "Use Postgres."], {
    recordHome,
    entryScript: FAKE_ANSWER_ENTRY,
    ...io,
  });
  const elapsedMs = Date.now() - started;

  assert.equal(code, 0, io.err[0]);
  assert.ok(elapsedMs < 2_000, `expected to return quickly (before the round runs), took ${elapsedMs}ms`);
  assert.deepEqual(io.err, []);
  assert.deepEqual(io.out, [
    `${task.id} resumed with your answer - running in the background. ` +
      `Follow progress with \`fabrica log ${task.id}\` or \`fabrica watch ${task.id}\`.`,
  ]);

  // The answer itself is already on the record (recorded synchronously,
  // in the foreground) ...
  const events = readEventsForTask(recordHome, task.id);
  assert.ok(events.some((e) => e.name === "answers-given"));

  // ... but the round itself has not run yet - spawning and loading a
  // real separate process takes measurably longer than this command's
  // own synchronous handoff.
  assert.ok(
    !readEventsForTask(recordHome, task.id).some((e) => e.name === "delivered"),
    "the resumed round must not have finished before runAnswerCommand returned"
  );

  const deadline = Date.now() + 10_000;
  let delivered = false;
  while (Date.now() < deadline) {
    if (readEventsForTask(recordHome, task.id).some((e) => e.name === "delivered")) {
      delivered = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(delivered, "the resumed round never delivered");

  const mine = (await createForeman({ recordHome, inspector: fixtureInspector() }).status()).find((t) => t.id === task.id);
  assert.equal(mine?.state, "delivered");
});

test("runAnswerCommand: bad usage refuses with exact instructions and exit 1", async () => {
  const recordHome = tempRecordHome();
  const io = captureIo();

  const code = await runAnswerCommand(["some-task"], { recordHome, ...io });

  assert.equal(code, 1);
  assert.deepEqual(io.out, []);
  assert.match(io.err[0], /"<text>"/);
});

test("runAnswerCommand: an unknown task id refuses with the Foreman's own message", async () => {
  const recordHome = tempRecordHome();
  const io = captureIo();

  const code = await runAnswerCommand(["no-such-task", "-m", "an answer"], { recordHome, ...io });

  assert.equal(code, 1);
  assert.deepEqual(io.out, []);
  assert.match(io.err[0], /no task "no-such-task"/);
});

test("runAnswerCommand: a task with no pending questions refuses", async () => {
  const recordHome = tempRecordHome();
  const task = await createForeman({ recordHome, inspector: fixtureInspector() }).do("small change", {
    project: makeFixtureRepo("exit 0"),
    brain: fakeBrain(),
  });
  const io = captureIo();

  const code = await runAnswerCommand([task.id, "-m", "an answer"], { recordHome, ...io });

  assert.equal(code, 1);
  assert.match(io.err[0], /never asked a clarifying question/);
});

test("runAnswerCommand: answering the same task twice refuses the second time", async () => {
  const recordHome = tempRecordHome();
  const task = await createForeman({ recordHome, inspector: fixtureInspector() }).do("build me an app", {
    project: makeFixtureRepo("exit 0"),
    brain: fakeBrain({ askQuestions: ["Which?"] }),
  });
  const first = await runAnswerCommand([task.id, "-m", "First answer."], {
    recordHome,
    entryScript: FAKE_ANSWER_ENTRY,
    ...captureIo(),
  });
  assert.equal(first, 0);

  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && !readEventsForTask(recordHome, task.id).some((e) => e.name === "delivered")) {
    await new Promise((r) => setTimeout(r, 100));
  }

  const io = captureIo();
  const code = await runAnswerCommand([task.id, "-m", "Second answer."], {
    recordHome,
    entryScript: FAKE_ANSWER_ENTRY,
    ...io,
  });

  assert.equal(code, 1);
  assert.match(io.err[0], /already got its one clarification round/);
});
