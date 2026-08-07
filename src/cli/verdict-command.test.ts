// runVerdictCommand end to end for accept/wrong - the CLI's own argument
// parsing, config-free record home, and message wording. Deliberately
// does not exercise "fix" through this layer: runVerdictCommand builds
// its own createForeman() with no brain override, so a "fix" here would
// reach for the real default adapter - the fix path itself (session
// resume, attempt counting) is proven against a fake brain directly in
// src/foreman/verdict.test.ts instead. The one exception below is a
// "fix" that refuses before any worker can run, which is precisely the
// case where an error from a lower layer has to reach the Client.

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

  const code = await runVerdictCommand([task.id, "accept", "looks right"], { recordHome, ...io });

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

  const code = await runVerdictCommand([task.id, "wrong", "not what I asked for"], { recordHome, ...io });

  assert.equal(code, 0);
  assert.match(io.out[0], new RegExp(`^wrong recorded: ${task.id} is closed\\.$`));
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

  const code = await runVerdictCommand([task.id, "fix", "one more pass"], { recordHome, ...io });

  assert.equal(code, 1);
  assert.deepEqual(io.out, []);
  assert.match(io.err[0], /workspace already exists/i);
});

test("runVerdictCommand: a verdict on an already-closed task refuses", async () => {
  const recordHome = tempRecordHome();
  const task = await createForeman({ recordHome }).do("small change", {
    project: makeFixtureRepo("exit 0"),
    brain: fakeBrain(),
  });
  await createForeman({ recordHome }).verdict(task.id, "accept", "good");
  const io = captureIo();

  const code = await runVerdictCommand([task.id, "wrong", "actually no"], { recordHome, ...io });

  assert.equal(code, 1);
  assert.match(io.err[0], /already has a final verdict/);
});
