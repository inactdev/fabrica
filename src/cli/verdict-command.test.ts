// runVerdictCommand end to end - the CLI's own argument parsing,
// config-free record home, and message wording, for every ruling. A
// successful "fix" wakes a worker, so it runs through the command's
// `brain` seam against a fake brain (the same shape do-command.test.ts
// uses `entryScript` for); what that proves here is the line the Client
// reads back, since the fix mechanism itself - session resume, round
// counting - is proven in src/foreman/verdict.test.ts. The refusing
// "fix" cases below stop before any worker can run, which is precisely
// where an error from a lower layer has to reach the Client instead of
// escaping - "fix" has no attempt budget of its own any more (issue
// #65), so what's left to refuse it is a missing note or a task with no
// delivery to reopen.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createForeman } from "../index.ts";
import { fakeBrain } from "../brain/helpers/fake-brain.ts";
import { makeFixtureRepo } from "../../contract/helpers/fixture.ts";
import { runVerdictCommand } from "./verdict-command.ts";

function tempRecordHome(): string {
  return mkdtempSync(join(tmpdir(), "fabrica-cli-verdict-command-"));
}

function captureIo() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, stdout: (l: string) => out.push(l), stderr: (l: string) => err.push(l) };
}

test("runVerdictCommand: accept closes the task and reports so", async () => {
  const recordHome = tempRecordHome();
  const task = await createForeman({ recordHome }).do("small change", {
    project: makeFixtureRepo("exit 0"),
    brain: fakeBrain(),
  });
  const io = captureIo();

  const code = await runVerdictCommand([task.id, "accept", "-m", "looks right"], { recordHome, ...io });

  assert.equal(code, 0);
  assert.deepEqual(io.err, []);
  assert.equal(io.out.length, 1);
  assert.match(io.out[0], new RegExp(`^accept recorded: ${task.id} is closed\\.$`));

  const mine = (await createForeman({ recordHome }).status()).find((t) => t.id === task.id);
  assert.equal(mine?.state, "closed");
});

test("runVerdictCommand: wrong closes the task and reports so", async () => {
  const recordHome = tempRecordHome();
  const task = await createForeman({ recordHome }).do("small change", {
    project: makeFixtureRepo("exit 0"),
    brain: fakeBrain(),
  });
  const io = captureIo();

  const code = await runVerdictCommand([task.id, "wrong", "-m", "not what I asked for"], { recordHome, ...io });

  assert.equal(code, 0);
  assert.match(io.out[0], new RegExp(`^wrong recorded: ${task.id} is closed\\.$`));

  const verdictEvent = (await createForeman({ recordHome }).events(task.id))
    .filter((e) => e.name === "verdict-recorded")
    .at(-1);
  assert.equal(
    (verdictEvent?.details as { note?: string } | undefined)?.note,
    "not what I asked for",
    "the -m note reaches the record verbatim"
  );
});

// SPEC.md's own example command, argument for argument, run against a
// task whose original attempt budget was 1 and already spent - issue
// #65's whole point: this used to refuse with "attempts-exhausted" and
// now succeeds, since a fix the Client asks for draws from no budget.
test("runVerdictCommand: the spec's `fix -m \"<note>\"` form succeeds past the task's original attempt budget", async () => {
  const recordHome = tempRecordHome();
  const brain = fakeBrain();
  const task = await createForeman({ recordHome }).do("small change", {
    project: makeFixtureRepo("exit 0"),
    brain,
    attempts: 1,
  });
  const io = captureIo();

  const code = await runVerdictCommand([task.id, "fix", "-m", "wrong button spot"], { recordHome, brain, ...io });

  assert.equal(code, 0, io.err[0]);
  assert.deepEqual(io.err, []);
  assert.deepEqual(io.out, [
    `fix round 1 recorded: ${task.id} ran again with your note - outcome: done. ` +
      `Still open; run \`fabrica verdict ${task.id} accept|fix|wrong\` once you've reviewed it.`,
  ]);
  assert.equal(brain.calls, 2, "the fix round woke the worker despite the original budget of 1 being spent");

  const verdictEvent = (await createForeman({ recordHome }).events(task.id))
    .filter((e) => e.name === "verdict-recorded")
    .at(-1);
  assert.equal(
    (verdictEvent?.details as { note?: string } | undefined)?.note,
    "wrong button spot",
    "the -m note reaches the record verbatim"
  );
});

// The one success path that actually runs a worker, and the only place
// the fix-success line the Client reads is produced. A fresh
// createForeman inside runVerdictCommand has no memory of the do() call,
// so the brain it hands the fix round is exactly the one this option
// supplies - the same substitution do-command.test.ts makes with
// entryScript.
test("runVerdictCommand: a fix that runs reports the round's outcome and that the task stays open", async () => {
  const recordHome = tempRecordHome();
  const brain = fakeBrain();
  // Attempts omitted, so the default budget of 2 applies and the green
  // first attempt leaves one unspent for the fix round to consume.
  const task = await createForeman({ recordHome }).do("small change", {
    project: makeFixtureRepo("exit 0"),
    brain,
  });
  const io = captureIo();

  const code = await runVerdictCommand([task.id, "fix", "-m", "wrong button spot"], { recordHome, brain, ...io });

  assert.equal(code, 0, io.err[0]);
  assert.deepEqual(io.err, []);
  assert.deepEqual(io.out, [
    `fix round 1 recorded: ${task.id} ran again with your note - outcome: done. ` +
      `Still open; run \`fabrica verdict ${task.id} accept|fix|wrong\` once you've reviewed it.`,
  ]);
  assert.equal(brain.calls, 2, "the fix round woke the worker exactly once more");

  const mine = (await createForeman({ recordHome }).status()).find((t) => t.id === task.id);
  assert.notEqual(mine?.state, "closed", "a fix leaves the task open for the Client's next word");
});

test("runVerdictCommand: bad usage refuses with exact instructions and exit 1", async () => {
  const recordHome = tempRecordHome();
  const io = captureIo();

  const code = await runVerdictCommand(["some-task"], { recordHome, ...io });

  assert.equal(code, 1);
  assert.deepEqual(io.out, []);
  assert.equal(io.err.length, 1);
  assert.match(io.err[0], /<accept\|fix\|wrong>/);
});

test("runVerdictCommand: an unknown task id refuses with the Foreman's own message", async () => {
  const recordHome = tempRecordHome();
  const io = captureIo();

  const code = await runVerdictCommand(["no-such-task", "accept"], { recordHome, ...io });

  assert.equal(code, 1);
  assert.deepEqual(io.out, []);
  assert.match(io.err[0], /no task "no-such-task"/);
});

test("runVerdictCommand: a ProductionLine refusal is printed, not thrown as a stack trace", async () => {
  const recordHome = tempRecordHome();
  const task = await createForeman({ recordHome }).do("small change", {
    project: makeFixtureRepo("exit 0"),
    brain: fakeBrain(),
  });
  // Something already sitting where a fix round would reopen the line -
  // reopenProductionLine refuses to reuse or overwrite it, with a
  // LineError, before any worker runs.
  mkdirSync(join(recordHome, "tasks", task.id, "worktree"), { recursive: true });
  const io = captureIo();

  const code = await runVerdictCommand([task.id, "fix", "-m", "one more pass"], { recordHome, ...io });

  assert.equal(code, 1);
  assert.deepEqual(io.out, []);
  assert.match(io.err[0], /workspace already exists/i);
});

// The point isn't this particular failure - it's that the command owns
// no list of error types to keep up to date. Rule 8 makes the brain
// pluggable, so the class thrown from inside a fix round is not knowable
// here; whatever it is, the Client gets its message and exit 1, on a
// task that already carries a verdict.
test("runVerdictCommand: an error from a layer it knows nothing about is still printed, not thrown", async () => {
  const recordHome = tempRecordHome();
  const task = await createForeman({ recordHome }).do("small change", {
    project: makeFixtureRepo("exit 0"),
    brain: fakeBrain(),
  });
  // A directory where the task's verdict file has to be written: the
  // record layer's own append fails, with a plain filesystem error.
  mkdirSync(join(recordHome, "tasks", task.id, "verdict"), { recursive: true });
  const io = captureIo();

  const code = await runVerdictCommand([task.id, "accept", "-m", "looks right"], { recordHome, ...io });

  assert.equal(code, 1);
  assert.deepEqual(io.out, []);
  assert.equal(io.err.length, 1);
  assert.match(io.err[0], /EISDIR|illegal operation on a directory/i);
});

test("runVerdictCommand: a verdict on an already-closed task refuses", async () => {
  const recordHome = tempRecordHome();
  const task = await createForeman({ recordHome }).do("small change", {
    project: makeFixtureRepo("exit 0"),
    brain: fakeBrain(),
  });
  await createForeman({ recordHome }).verdict(task.id, "accept", "good");
  const io = captureIo();

  const code = await runVerdictCommand([task.id, "wrong", "-m", "actually no"], { recordHome, ...io });

  assert.equal(code, 1);
  assert.match(io.err[0], /already has a final verdict/);
});
