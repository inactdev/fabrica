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
    brain: fakeBrain({ askQuestion: { question: "What database should this use?", options: ["Postgres", "SQLite"] } }),
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
    brain: fakeBrain({ askQuestion: { question: "Which?", options: ["This", "That"] } }),
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

// Issue #176: answering by picking an option, which is the ordinary way
// now - no words of the Client's own at all.
test("runAnswerCommand: an option pick records that option's own text as the answer", async () => {
  const recordHome = tempRecordHome();
  const task = await createForeman({ recordHome, inspector: fixtureInspector() }).do("build me an app", {
    project: makeFixtureRepo("exit 0"),
    brain: fakeBrain({ askQuestion: { question: "Which database?", options: ["Postgres", "SQLite"] } }),
  });
  const io = captureIo();

  const code = await runAnswerCommand([task.id, "--option", "2"], { recordHome, entryScript: FAKE_ANSWER_ENTRY, ...io });

  assert.equal(code, 0, io.err[0]);
  const answered = readEventsForTask(recordHome, task.id).find((e) => e.name === "answers-given");
  assert.equal((answered!.details as { answer?: string }).answer, "SQLite");
});

// Issue #175: the first answer wins, and the Client is told so rather
// than left thinking his second answer was applied.
test("runAnswerCommand: a second answer that names no question says the first one stands", async () => {
  const recordHome = tempRecordHome();
  const task = await createForeman({ recordHome, inspector: fixtureInspector() }).do("build me an app", {
    project: makeFixtureRepo("exit 0"),
    brain: fakeBrain({ askQuestion: { question: "Which database?", options: ["Postgres", "SQLite"] } }),
  });
  await runAnswerCommand([task.id, "--option", "1"], { recordHome, entryScript: FAKE_ANSWER_ENTRY, ...captureIo() });

  const io = captureIo();
  const code = await runAnswerCommand([task.id, "-m", "No, SQLite."], {
    recordHome,
    entryScript: FAKE_ANSWER_ENTRY,
    ...io,
  });

  assert.equal(code, 0);
  assert.match(io.err.join("\n"), /already has an answer - the first answer stands \("Postgres"\)/);
  assert.match(io.err.join("\n"), /--question q-[0-9a-f]{12}/);
  // Only the first answer is on the record; nothing was rewritten.
  const answers = readEventsForTask(recordHome, task.id).filter((e) => e.name === "answers-given");
  assert.equal(answers.length, 1);
});

test("runAnswerCommand: an option the question does not have refuses, and records nothing", async () => {
  const recordHome = tempRecordHome();
  const task = await createForeman({ recordHome, inspector: fixtureInspector() }).do("build me an app", {
    project: makeFixtureRepo("exit 0"),
    brain: fakeBrain({ askQuestion: { question: "Which database?", options: ["Postgres", "SQLite"] } }),
  });
  const io = captureIo();

  const code = await runAnswerCommand([task.id, "--option", "7"], { recordHome, entryScript: FAKE_ANSWER_ENTRY, ...io });

  assert.equal(code, 1);
  assert.match(io.err.join("\n"), /there is no option 7 on this question/);
  assert.ok(!readEventsForTask(recordHome, task.id).some((e) => e.name === "answers-given"));
});
