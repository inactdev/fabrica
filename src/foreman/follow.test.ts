import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendEvent, appendTaskFile } from "../record/index.ts";
import { followTask } from "./follow.ts";

function tempRecordHome(): string {
  return mkdtempSync(join(tmpdir(), "fabrica-foreman-follow-"));
}

function appendTranscript(recordHome: string, taskId: string, text: string): void {
  appendTaskFile(
    recordHome,
    taskId,
    "transcript.log",
    JSON.stringify({ occurredAt: new Date().toISOString(), kind: "text", text }) + "\n"
  );
}

test("followTask: a task with nothing on the record yet reads as empty, not an error", () => {
  const recordHome = tempRecordHome();
  const progress = followTask(recordHome, "t1").read();
  assert.deepEqual(progress.events, []);
  assert.deepEqual(progress.transcript, []);
});

test("followTask: each read returns the task's whole history, including what landed since the last one", () => {
  const recordHome = tempRecordHome();
  appendEvent(recordHome, { taskId: "t1", name: "task-received" });
  appendTranscript(recordHome, "t1", "first");

  const follower = followTask(recordHome, "t1");
  const first = follower.read();
  assert.deepEqual(first.events.map((e) => e.name), ["task-received"]);
  assert.deepEqual(first.transcript.map((e) => e.text), ["first"]);

  appendEvent(recordHome, { taskId: "t1", name: "work-started" });
  appendTranscript(recordHome, "t1", "second");

  const second = follower.read();
  assert.deepEqual(second.events.map((e) => e.name), ["task-received", "work-started"]);
  assert.deepEqual(second.transcript.map((e) => e.text), ["first", "second"]);
});

test("followTask: another task's events never leak into this one's history", () => {
  const recordHome = tempRecordHome();
  appendEvent(recordHome, { taskId: "t1", name: "task-received" });
  appendEvent(recordHome, { taskId: "t2", name: "task-received" });

  const follower = followTask(recordHome, "t1");
  assert.equal(follower.read().events.length, 1);

  appendEvent(recordHome, { taskId: "t2", name: "heartbeat" });
  appendEvent(recordHome, { taskId: "t1", name: "heartbeat" });

  assert.deepEqual(
    follower.read().events.map((e) => `${e.taskId}:${e.name}`),
    ["t1:task-received", "t1:heartbeat"]
  );
});

test("followTask: mutating one read's result never affects the next read's result", () => {
  const recordHome = tempRecordHome();
  appendEvent(recordHome, { taskId: "t1", name: "task-received" });
  appendTranscript(recordHome, "t1", "first");

  const follower = followTask(recordHome, "t1");
  const progress = follower.read();
  progress.events.push({ occurredAt: "", taskId: "t1", name: "delivered" });
  progress.transcript.length = 0;

  const again = follower.read();
  assert.deepEqual(again.events.map((e) => e.name), ["task-received"]);
  assert.deepEqual(again.transcript.map((e) => e.text), ["first"]);
});

test("followTask: a permanently torn line is skipped, not thrown, and the rest still reads", () => {
  const recordHome = tempRecordHome();
  appendEvent(recordHome, { taskId: "t1", name: "task-received" });
  appendTaskFile(recordHome, "t1", "transcript.log", '{"occurredAt":"2026-01-0\n');
  appendTranscript(recordHome, "t1", "after the torn line");

  const progress = followTask(recordHome, "t1").read();
  assert.deepEqual(progress.transcript.map((e) => e.text), ["after the torn line"]);
});
