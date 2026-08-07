// runVerdictCommand end to end for accept/wrong - the CLI's own argument
// parsing, config-free record home, and message wording. Deliberately
// does not exercise "fix" through this layer: runVerdictCommand builds
// its own createForeman() with no brain override, so a "fix" here would
// reach for the real default adapter - the fix path itself (session
// resume, attempt counting) is proven against a fake brain directly in
// src/foreman/verdict.test.ts instead.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
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
