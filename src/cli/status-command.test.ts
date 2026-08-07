import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createForeman } from "../index.ts";
import { fakeBrain } from "../brain/helpers/fake-brain.ts";
import { makeFixtureRepo } from "../../contract/helpers/fixture.ts";
import { runStatusCommand } from "./status-command.ts";

function tempRecordHome(): string {
  return mkdtempSync(join(tmpdir(), "fabrica-cli-status-command-"));
}

function captureIo() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, stdout: (l: string) => out.push(l), stderr: (l: string) => err.push(l) };
}

test("runStatusCommand: no tasks at all says so plainly", async () => {
  const io = captureIo();
  const code = await runStatusCommand([], { recordHome: tempRecordHome(), ...io });
  assert.equal(code, 0);
  assert.deepEqual(io.out, ["No open tasks."]);
});

test("runStatusCommand: a delivered task is flagged as awaiting the Client's verdict", async () => {
  const recordHome = tempRecordHome();
  const project = makeFixtureRepo("exit 0");
  const task = await createForeman({ recordHome }).do("small change", { project, brain: fakeBrain() });
  const io = captureIo();

  const code = await runStatusCommand([], { recordHome, ...io });

  assert.equal(code, 0);
  assert.equal(io.out.length, 1);
  assert.match(io.out[0], new RegExp(`^${task.id}\\s`));
  assert.match(io.out[0], /delivered/);
  assert.match(io.out[0], /AWAITING YOUR VERDICT/);
  assert.match(io.out[0], new RegExp(project.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("runStatusCommand: a closed task (verdict recorded) drops off the list", async () => {
  const recordHome = tempRecordHome();
  const project = makeFixtureRepo("exit 0");
  const task = await createForeman({ recordHome }).do("small change", { project, brain: fakeBrain() });
  await createForeman({ recordHome }).verdict(task.id, "accept", "good");
  const io = captureIo();

  const code = await runStatusCommand([], { recordHome, ...io });

  assert.equal(code, 0);
  assert.deepEqual(io.out, ["No open tasks."]);
});

test("runStatusCommand: an unknown flag is refused with exact instructions, not ignored", async () => {
  const io = captureIo();
  const code = await runStatusCommand(["--json"], { recordHome: tempRecordHome(), ...io });

  assert.equal(code, 1);
  assert.deepEqual(io.out, []);
  assert.match(io.err[0], /unknown flag "--json"/);
  assert.match(io.err[0], /Usage: fabrica status/);
});

test("runStatusCommand: a stray positional is refused and points at `fabrica log`", async () => {
  const io = captureIo();
  const code = await runStatusCommand(["some-task-id"], { recordHome: tempRecordHome(), ...io });

  assert.equal(code, 1);
  assert.deepEqual(io.out, []);
  assert.match(io.err[0], /unexpected argument "some-task-id"/);
  assert.match(io.err[0], /fabrica log <taskId>/);
});

test("runStatusCommand: a red delivery shows failed, not delivered, and carries no verdict flag", async () => {
  const recordHome = tempRecordHome();
  const project = makeFixtureRepo("exit 1");
  const task = await createForeman({ recordHome }).do("small change", { project, brain: fakeBrain() });
  const io = captureIo();

  const code = await runStatusCommand([], { recordHome, ...io });

  assert.equal(code, 0);
  assert.match(io.out[0], new RegExp(`^${task.id}\\s`));
  assert.match(io.out[0], /failed/);
  assert.doesNotMatch(io.out[0], /AWAITING YOUR VERDICT/);
});
