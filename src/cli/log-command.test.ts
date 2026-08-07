import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createForeman } from "../index.ts";
import { appendEvent } from "../record/index.ts";
import { fakeBrain } from "../brain/helpers/fake-brain.ts";
import { makeFixtureRepo } from "../../contract/helpers/fixture.ts";
import { runLogCommand } from "./log-command.ts";

function tempRecordHome(): string {
  return mkdtempSync(join(tmpdir(), "fabrica-cli-log-command-"));
}

function captureIo() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, stdout: (l: string) => out.push(l), stderr: (l: string) => err.push(l) };
}

test("runLogCommand: prints the task's full event history, in order", async () => {
  const recordHome = tempRecordHome();
  const project = makeFixtureRepo("exit 0");
  const task = await createForeman({ recordHome }).do("small change", { project, brain: fakeBrain() });
  const io = captureIo();

  const code = await runLogCommand([task.id], { recordHome, ...io });

  assert.equal(code, 0);
  assert.deepEqual(io.err, []);
  const names = io.out.map((line) => line.split(/\s+/)[1]);
  // "check-run" lands twice per attempt: once when the check starts
  // (details.phase === "started", issue #12) and once with its result.
  assert.deepEqual(names, ["task-received", "line-cut", "work-started", "check-run", "check-run", "delivered"]);
});

test("runLogCommand: --transcript appends the worker's raw transcript", async () => {
  const recordHome = tempRecordHome();
  const project = makeFixtureRepo("exit 0");
  const task = await createForeman({ recordHome }).do("small change", { project, brain: fakeBrain() });
  const io = captureIo();

  const code = await runLogCommand([task.id, "--transcript"], { recordHome, ...io });

  assert.equal(code, 0);
  assert.ok(io.out.some((line) => line === "--- transcript ---"));
  assert.ok(io.out.some((line) => line.includes("small change")));
});

test("runLogCommand: without --transcript, no transcript section at all", async () => {
  const recordHome = tempRecordHome();
  const project = makeFixtureRepo("exit 0");
  const task = await createForeman({ recordHome }).do("small change", { project, brain: fakeBrain() });
  const io = captureIo();

  await runLogCommand([task.id], { recordHome, ...io });

  assert.ok(!io.out.some((line) => line.startsWith("--- transcript")));
});

test("runLogCommand: a run of heartbeats collapses into one line instead of flooding the history", async () => {
  const recordHome = tempRecordHome();
  appendEvent(recordHome, { taskId: "t1", name: "task-received" });
  appendEvent(recordHome, { taskId: "t1", name: "work-started", details: { project: "/repo" } });
  for (let i = 0; i < 14; i++) appendEvent(recordHome, { taskId: "t1", name: "heartbeat", details: { attempt: 1 } });
  appendEvent(recordHome, { taskId: "t1", name: "check-run", details: { attempt: 1, phase: "started" } });

  const io = captureIo();
  const code = await runLogCommand(["t1"], { recordHome, ...io });

  assert.equal(code, 0);
  const heartbeatLines = io.out.filter((line) => line.includes("heartbeat"));
  assert.equal(heartbeatLines.length, 1, `expected the 14 heartbeats collapsed to one line, got: ${JSON.stringify(io.out)}`);
  assert.match(heartbeatLines[0], /^\S+  heartbeat  14 heartbeats over/);
});

test("runLogCommand: an unknown task id refuses plainly", async () => {
  const io = captureIo();
  const code = await runLogCommand(["no-such-task"], { recordHome: tempRecordHome(), ...io });

  assert.equal(code, 1);
  assert.deepEqual(io.out, []);
  assert.match(io.err[0], /no task "no-such-task"/);
});

test("runLogCommand: bad usage refuses with exact instructions", async () => {
  const io = captureIo();
  const code = await runLogCommand([], { recordHome: tempRecordHome(), ...io });

  assert.equal(code, 1);
  assert.match(io.err[0], /missing <taskId>/);
});
