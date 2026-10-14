// runAwaitCommand end to end. The command's whole job: stay silent
// through anything that isn't one of the five states the Client needs
// to act on or already knows about (delivered, asking, failed, closed,
// refused), and print exactly one line, then exit, the moment one of
// them lands - immediately if the task already started there.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendEvent } from "../record/index.ts";
import { runAwaitCommand } from "./await-command.ts";

function tempRecordHome(): string {
  return mkdtempSync(join(tmpdir(), "fabrica-cli-await-command-"));
}

function captureIo() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, stdout: (l: string) => out.push(l), stderr: (l: string) => err.push(l) };
}

async function waitFor(condition: () => boolean, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return condition();
}

test("runAwaitCommand: a task already delivered when it starts exits at once", async () => {
  const recordHome = tempRecordHome();
  appendEvent(recordHome, { taskId: "t1", name: "task-received" });
  appendEvent(recordHome, { taskId: "t1", name: "work-started", details: { project: "/some/project" } });
  appendEvent(recordHome, {
    taskId: "t1",
    name: "delivered",
    details: { outcome: "done", delivery: { confidence: 100, summary: "done", branch: "fabrica/t1", files: [] } },
  });

  const io = captureIo();
  const code = await runAwaitCommand(["t1"], { recordHome, pollIntervalMs: 10, ...io });

  assert.equal(code, 0);
  assert.deepEqual(io.out, ["t1 delivered - awaiting your verdict"]);
});

test("runAwaitCommand: a task already asking when it starts exits at once", async () => {
  const recordHome = tempRecordHome();
  appendEvent(recordHome, { taskId: "t1", name: "task-received" });
  appendEvent(recordHome, { taskId: "t1", name: "questions-asked", details: { questions: ["Which endpoint?"] } });

  const io = captureIo();
  const code = await runAwaitCommand(["t1"], { recordHome, pollIntervalMs: 10, ...io });

  assert.equal(code, 0);
  assert.deepEqual(io.out, ["t1 asked a question - answer with fabrica answer t1"]);
});

test("runAwaitCommand: a task already failed (ask-failed, never delivered) when it starts exits at once", async () => {
  const recordHome = tempRecordHome();
  appendEvent(recordHome, { taskId: "t1", name: "task-received" });
  appendEvent(recordHome, { taskId: "t1", name: "ask-failed", details: { error: "the brain is unreachable" } });

  const io = captureIo();
  const code = await runAwaitCommand(["t1"], { recordHome, pollIntervalMs: 10, ...io });

  assert.equal(code, 0);
  assert.deepEqual(io.out, ["t1 failed - see fabrica log t1"]);
});

test("runAwaitCommand: a task with a real failed delivery also exits with the failed line", async () => {
  const recordHome = tempRecordHome();
  appendEvent(recordHome, { taskId: "t1", name: "task-received" });
  appendEvent(recordHome, { taskId: "t1", name: "work-started", details: { project: "/some/project" } });
  appendEvent(recordHome, {
    taskId: "t1",
    name: "delivered",
    details: { outcome: "failure-report", delivery: { confidence: 0, summary: "red", branch: "fabrica/t1", files: [] } },
  });

  const io = captureIo();
  const code = await runAwaitCommand(["t1"], { recordHome, pollIntervalMs: 10, ...io });

  assert.equal(code, 0);
  assert.deepEqual(io.out, ["t1 failed - see fabrica log t1"]);
});

// Client ruling, follow-up review: before this, `fabrica await` named no
// line at all for "closed" or "refused" - either one meant polling
// forever even though neither can ever move again.
test("runAwaitCommand: a task already closed (verdict recorded) when it starts exits at once", async () => {
  const recordHome = tempRecordHome();
  appendEvent(recordHome, { taskId: "t1", name: "task-received" });
  appendEvent(recordHome, { taskId: "t1", name: "work-started", details: { project: "/some/project" } });
  appendEvent(recordHome, {
    taskId: "t1",
    name: "delivered",
    details: { outcome: "done", delivery: { confidence: 100, summary: "done", branch: "fabrica/t1", files: [] } },
  });
  appendEvent(recordHome, { taskId: "t1", name: "verdict-recorded", details: { ruling: "accept", note: "good" } });

  const io = captureIo();
  const code = await runAwaitCommand(["t1"], { recordHome, pollIntervalMs: 10, ...io });

  assert.equal(code, 0);
  assert.deepEqual(io.out, ["t1 is already closed"]);
});

test("runAwaitCommand: a task already refused by Inspector when it starts exits at once", async () => {
  const recordHome = tempRecordHome();
  appendEvent(recordHome, { taskId: "t1", name: "task-received" });
  appendEvent(recordHome, { taskId: "t1", name: "work-started", details: { project: "/some/project" } });
  appendEvent(recordHome, { taskId: "t1", name: "inspector-called", details: { branch: "fabrica/t1" } });
  appendEvent(recordHome, {
    taskId: "t1",
    name: "inspection-finished",
    details: { verdict: "refused", report: "GITHUB_TOKEN is missing" },
  });

  const io = captureIo();
  const code = await runAwaitCommand(["t1"], { recordHome, pollIntervalMs: 10, ...io });

  assert.equal(code, 0);
  assert.deepEqual(io.out, ["t1 was refused by Inspector - see fabrica log t1"]);
});

test("runAwaitCommand: heartbeats alone never trigger an exit", async () => {
  const recordHome = tempRecordHome();
  appendEvent(recordHome, { taskId: "t1", name: "task-received" });
  appendEvent(recordHome, { taskId: "t1", name: "work-started", details: { project: "/some/project" } });
  for (let i = 0; i < 5; i++) appendEvent(recordHome, { taskId: "t1", name: "heartbeat", details: { attempt: 1 } });

  const io = captureIo();
  const controller = new AbortController();
  const awaitPromise = runAwaitCommand(["t1"], { recordHome, signal: controller.signal, pollIntervalMs: 10, ...io });

  // Give the loop several poll cycles to (wrongly) exit on a heartbeat
  // before cancelling it ourselves.
  await new Promise((resolve) => setTimeout(resolve, 100));
  appendEvent(recordHome, { taskId: "t1", name: "heartbeat", details: { attempt: 1 } });
  await new Promise((resolve) => setTimeout(resolve, 100));
  controller.abort();
  const code = await awaitPromise;

  assert.equal(code, 0);
  assert.deepEqual(io.out, [], "a heartbeat must never produce the one expected exit line");
});

test("runAwaitCommand: a live transition to delivered, after heartbeats, is caught and reported", async () => {
  const recordHome = tempRecordHome();
  appendEvent(recordHome, { taskId: "t1", name: "task-received" });
  appendEvent(recordHome, { taskId: "t1", name: "work-started", details: { project: "/some/project" } });

  const io = captureIo();
  const awaitPromise = runAwaitCommand(["t1"], { recordHome, pollIntervalMs: 10, ...io });

  appendEvent(recordHome, { taskId: "t1", name: "heartbeat", details: { attempt: 1 } });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(io.out, [], "must still be silent before delivery");

  appendEvent(recordHome, {
    taskId: "t1",
    name: "delivered",
    details: { outcome: "done", delivery: { confidence: 100, summary: "done", branch: "fabrica/t1", files: [] } },
  });
  assert.ok(await waitFor(() => io.out.length > 0));
  const code = await awaitPromise;

  assert.equal(code, 0);
  assert.deepEqual(io.out, ["t1 delivered - awaiting your verdict"]);
});

test("runAwaitCommand: a live transition to asking is caught and reported", async () => {
  const recordHome = tempRecordHome();
  appendEvent(recordHome, { taskId: "t1", name: "task-received" });

  const io = captureIo();
  const awaitPromise = runAwaitCommand(["t1"], { recordHome, pollIntervalMs: 10, ...io });

  appendEvent(recordHome, { taskId: "t1", name: "questions-asked", details: { questions: ["Which endpoint?"] } });
  assert.ok(await waitFor(() => io.out.length > 0));
  const code = await awaitPromise;

  assert.equal(code, 0);
  assert.deepEqual(io.out, ["t1 asked a question - answer with fabrica answer t1"]);
});

test("runAwaitCommand: a live transition to failed is caught and reported", async () => {
  const recordHome = tempRecordHome();
  appendEvent(recordHome, { taskId: "t1", name: "task-received" });

  const io = captureIo();
  const awaitPromise = runAwaitCommand(["t1"], { recordHome, pollIntervalMs: 10, ...io });

  appendEvent(recordHome, { taskId: "t1", name: "ask-failed", details: { error: "no credential" } });
  assert.ok(await waitFor(() => io.out.length > 0));
  const code = await awaitPromise;

  assert.equal(code, 0);
  assert.deepEqual(io.out, ["t1 failed - see fabrica log t1"]);
});

test("runAwaitCommand: an unknown task id refuses plainly", async () => {
  const io = captureIo();
  const code = await runAwaitCommand(["no-such-task"], { recordHome: tempRecordHome(), ...io });

  assert.equal(code, 1);
  assert.deepEqual(io.out, []);
  assert.match(io.err[0], /no task "no-such-task"/);
});

test("runAwaitCommand: bad usage refuses with exact instructions", async () => {
  const io = captureIo();
  const code = await runAwaitCommand([], { recordHome: tempRecordHome(), ...io });

  assert.equal(code, 1);
  assert.match(io.err[0], /missing <taskId>/);
});
