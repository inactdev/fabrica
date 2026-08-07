import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createForeman } from "../index.ts";
import { fakeBrain } from "../brain/helpers/fake-brain.ts";
import { makeFixtureRepo } from "../../contract/helpers/fixture.ts";
import { runDoCommand } from "./do-command.ts";
import { runStatusCommand } from "./status-command.ts";

// A real, separate detached process (see do-command.test.ts): runCheck is
// synchronous execSync, so a slow check blocks that process's own event
// loop start to finish - polling `fabrica status` from THIS test process
// concurrently, while it's mid-check, needs a genuinely different OS
// process, not just an unawaited in-process promise.
const FAKE_ENTRY = fileURLToPath(new URL("./helpers/fake-run-task-entry.ts", import.meta.url));

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

// Runs `fabrica status` until one of its lines matches, and returns that
// very output - how long the detached process takes to boot tsx, register
// and reach its check is not something a fixed wait can predict.
async function statusUntil(recordHome: string, wanted: RegExp, timeoutMs = 20_000): Promise<string[]> {
  const deadline = Date.now() + timeoutMs;
  let last: string[] = [];
  while (Date.now() < deadline) {
    const io = captureIo();
    const code = await runStatusCommand([], { recordHome, ...io });
    assert.equal(code, 0);
    if (io.out.some((line) => wanted.test(line))) return io.out;
    last = io.out;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`timed out waiting for ${wanted} in \`fabrica status\`; last output: ${JSON.stringify(last)}`);
}

test("runStatusCommand: a task mid-check says so plainly, with real elapsed time, never quiet", async () => {
  const recordHome = tempRecordHome();
  const project = makeFixtureRepo("sleep 2 && exit 0");

  const doIo = { out: [] as string[], err: [] as string[], stdout: (l: string) => doIo.out.push(l), stderr: () => {} };
  await runDoCommand(["small change", "--project", project], { recordHome, entryScript: FAKE_ENTRY, ...doIo });
  const taskId = doIo.out[0];

  const out = await statusUntil(recordHome, /checking/);

  assert.equal(out.length, 1);
  assert.match(out[0], new RegExp(`^${taskId}\\s`));
  assert.match(out[0], /checking, \d+s so far/);
  assert.doesNotMatch(out[0], /quiet/);
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
