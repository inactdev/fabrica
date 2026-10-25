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
import { fixtureInspector } from "../../contract/helpers/fake-inspector.ts";

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
  const task = await createForeman({ recordHome, inspector: fixtureInspector() }).do("small change", { project, brain: fakeBrain() });
  const io = captureIo();

  const code = await runLogCommand([task.id], { recordHome, ...io });

  assert.equal(code, 0);
  assert.deepEqual(io.err, []);
  const names = io.out.map((line) => line.split(/\s+/)[1]);
  // With Inspector, each attempt is judged by Inspector's own run, never a
  // Fabrica "check-run" (issue #64). "reader-failed" is here because this
  // record home configures no `[reader]` (inspector issue #34): the read
  // was due the moment Inspector went green, and a read that was due and
  // could not happen is said out loud rather than skipped - `fabrica do`
  // is what refuses a real task for this up front.
  assert.deepEqual(names, ["task-received", "ask-cost-recorded", "line-cut", "work-started", "inspector-called", "inspection-finished", "receipt-recorded", "reader-failed", "delivered"]);
});

test("runLogCommand: --transcript appends the worker's raw transcript", async () => {
  const recordHome = tempRecordHome();
  const project = makeFixtureRepo("exit 0");
  const task = await createForeman({ recordHome, inspector: fixtureInspector() }).do("small change", { project, brain: fakeBrain() });
  const io = captureIo();

  const code = await runLogCommand([task.id, "--transcript"], { recordHome, ...io });

  assert.equal(code, 0);
  assert.ok(io.out.some((line) => line === "--- transcript ---"));
  assert.ok(io.out.some((line) => line.includes("small change")));
});

test("runLogCommand: without --transcript, no transcript section at all", async () => {
  const recordHome = tempRecordHome();
  const project = makeFixtureRepo("exit 0");
  const task = await createForeman({ recordHome, inspector: fixtureInspector() }).do("small change", { project, brain: fakeBrain() });
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

// Issue #169: a task-failure message used to come out cut off mid-word -
// the reason the task died was the one thing the log didn't say.
const REOPEN_FAILURE =
  "Could not reopen the ProductionLine for fabrica/20261014-t-aa from /Users/o/proj: " +
  "git worktree add failed:\n" +
  "fatal: 'fabrica/20261014-t-aa' is already used by worktree at '/Users/o/.fabrica/work/20261014-t-aa'\n" +
  "hint: remove it with `git worktree remove`, or run the task again under a new id";

test("runLogCommand: a failure's whole reason reaches the output, wrapped rather than cut", async () => {
  const recordHome = tempRecordHome();
  appendEvent(recordHome, { taskId: "t1", name: "task-received" });
  appendEvent(recordHome, { taskId: "t1", name: "task-failed", details: { message: REOPEN_FAILURE } });

  const io = captureIo();
  const code = await runLogCommand(["t1"], { recordHome, wrapWidth: 72, ...io });

  assert.equal(code, 0);
  // Every word of the reason is somewhere in the output, and nothing
  // trails off: wrapping moves text to the next line, it doesn't drop it.
  const printed = io.out.join("\n");
  for (const word of REOPEN_FAILURE.split(/\s+/)) {
    assert.ok(printed.includes(word), `"${word}" went missing from:\n${printed}`);
  }
  assert.ok(!printed.includes("…"), `nothing should trail off:\n${printed}`);
  for (const line of io.out) assert.ok(line.length <= 72, `line over the width (${line.length}): ${line}`);
  // One event line, then continuation lines indented under it - the
  // timestamp column still scans.
  assert.match(io.out[1], /^\S+  task-failed  Could not reopen/);
  assert.ok(io.out.length > 3, `expected the reason to need several lines, got ${io.out.length}`);
  for (const line of io.out.slice(2)) assert.match(line, /^ {4}\S/);
});

test("runLogCommand: a caller that brought its own stdout gets unwrapped output, not this window's width", async () => {
  const recordHome = tempRecordHome();
  appendEvent(recordHome, { taskId: "t1", name: "task-received" });
  appendEvent(recordHome, { taskId: "t1", name: "task-failed", details: { message: "a".repeat(400) } });

  const io = captureIo();
  await runLogCommand(["t1"], { recordHome, ...io });

  // No wrapWidth passed and stdout is not the real terminal, so the
  // reason comes out on one line: a piped or captured `fabrica log` must
  // not reflow to whatever size the window running it happens to be.
  assert.equal(io.out.length, 2);
  assert.ok(io.out[1].endsWith("a".repeat(400)));
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
