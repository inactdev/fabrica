// The two read-side seams `fabrica status`/`watch` (issue #12) lean on so
// they don't re-read the whole event log per task: one grouped pass over
// events.jsonl, and state derived from events already in hand.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendEvent } from "../record/index.ts";
import { eventsByTask, stateOf, statusOf } from "./queries.ts";

function tempRecordHome(): string {
  return mkdtempSync(join(tmpdir(), "fabrica-foreman-queries-"));
}

test("eventsByTask: one pass, grouped by task id, each group in record order", () => {
  const recordHome = tempRecordHome();
  appendEvent(recordHome, { taskId: "a", name: "task-received" });
  appendEvent(recordHome, { taskId: "b", name: "task-received" });
  appendEvent(recordHome, { taskId: "a", name: "work-started", details: { project: "/p" } });

  const byTask = eventsByTask(recordHome);

  assert.deepEqual([...byTask.keys()], ["a", "b"]);
  assert.deepEqual(
    byTask.get("a")!.map((e) => e.name),
    ["task-received", "work-started"]
  );
  assert.equal(byTask.get("b")!.length, 1);
});

test("eventsByTask: an empty record home is an empty map, not a throw", () => {
  assert.equal(eventsByTask(tempRecordHome()).size, 0);
});

test("stateOf: gives the same answer statusOf does, from the events alone", () => {
  const recordHome = tempRecordHome();
  appendEvent(recordHome, { taskId: "t1", name: "task-received" });
  appendEvent(recordHome, { taskId: "t1", name: "work-started", details: { project: "/p" } });
  appendEvent(recordHome, { taskId: "t1", name: "heartbeat", details: { attempt: 1 } });
  appendEvent(recordHome, { taskId: "t1", name: "check-run", details: { attempt: 1, green: true } });
  appendEvent(recordHome, { taskId: "t1", name: "delivered", details: { outcome: "done" } });

  const events = eventsByTask(recordHome).get("t1")!;

  assert.equal(stateOf(events), "delivered");
  assert.deepEqual(statusOf(recordHome), [{ id: "t1", state: "delivered" }]);
});

test("stateOf: a recorded accept closes the task; a fix does not", () => {
  const base = [
    { occurredAt: "t0", taskId: "t1", name: "work-started" as const },
    { occurredAt: "t1", taskId: "t1", name: "delivered" as const, details: { outcome: "done" } },
  ];

  assert.equal(
    stateOf([...base, { occurredAt: "t2", taskId: "t1", name: "verdict-recorded", details: { ruling: "accept" } }]),
    "closed"
  );
  assert.equal(
    stateOf([...base, { occurredAt: "t2", taskId: "t1", name: "verdict-recorded", details: { ruling: "fix" } }]),
    "delivered"
  );
});
