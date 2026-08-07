// runAnswerCommand end to end - the CLI's own argument parsing,
// config-free record home, and message wording. Resuming always wakes a
// worker (unlike verdict's accept/wrong), so every success path runs
// through the command's `brain` seam against a fake brain, the same
// shape verdict-command.test.ts and do-command.test.ts use.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createForeman } from "../index.ts";
import { fakeBrain } from "../brain/helpers/fake-brain.ts";
import { makeFixtureRepo } from "../../contract/helpers/fixture.ts";
import { runAnswerCommand } from "./answer-command.ts";

function tempRecordHome(): string {
  return mkdtempSync(join(tmpdir(), "fabrica-cli-answer-command-"));
}

function captureIo() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, stdout: (l: string) => out.push(l), stderr: (l: string) => err.push(l) };
}

test("runAnswerCommand: resumes an asking task and reports the outcome", async () => {
  const recordHome = tempRecordHome();
  const task = await createForeman({ recordHome }).do("build me an app", {
    project: makeFixtureRepo("exit 0"),
    brain: fakeBrain({ askQuestions: ["What database should this use?"] }),
  });
  assert.equal(task.state, "asking");
  const brain = fakeBrain();
  const io = captureIo();

  const code = await runAnswerCommand([task.id, "Use Postgres."], { recordHome, brain, ...io });

  assert.equal(code, 0, io.err[0]);
  assert.deepEqual(io.err, []);
  assert.deepEqual(io.out, [
    `${task.id} resumed with your answer - outcome: done. ` +
      `Run \`fabrica verdict ${task.id} accept|fix|wrong\` once you've reviewed it.`,
  ]);
  assert.equal(brain.calls, 1);

  const mine = (await createForeman({ recordHome }).status()).find((t) => t.id === task.id);
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

  const code = await runAnswerCommand(["no-such-task", "an answer"], { recordHome, ...io });

  assert.equal(code, 1);
  assert.deepEqual(io.out, []);
  assert.match(io.err[0], /no task "no-such-task"/);
});

test("runAnswerCommand: a task with no pending questions refuses", async () => {
  const recordHome = tempRecordHome();
  const task = await createForeman({ recordHome }).do("small change", {
    project: makeFixtureRepo("exit 0"),
    brain: fakeBrain(),
  });
  const io = captureIo();

  const code = await runAnswerCommand([task.id, "an answer"], { recordHome, ...io });

  assert.equal(code, 1);
  assert.match(io.err[0], /never asked a clarifying question/);
});

test("runAnswerCommand: answering the same task twice refuses the second time", async () => {
  const recordHome = tempRecordHome();
  const task = await createForeman({ recordHome }).do("build me an app", {
    project: makeFixtureRepo("exit 0"),
    brain: fakeBrain({ askQuestions: ["Which?"] }),
  });
  await runAnswerCommand([task.id, "First answer."], { recordHome, brain: fakeBrain(), ...captureIo() });
  const io = captureIo();

  const code = await runAnswerCommand([task.id, "Second answer."], { recordHome, brain: fakeBrain(), ...io });

  assert.equal(code, 1);
  assert.match(io.err[0], /already got its one clarification round/);
});
