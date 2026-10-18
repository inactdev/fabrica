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

// A failed task must stay failed. `fabrica status` and the live view
// both showed one as "working" 15 minutes after its own "task-failed"
// event, because the pass let any later live-looking event overwrite it.
const FAILED_ROUND = [
  { occurredAt: "t0", taskId: "t1", name: "task-received" as const },
  { occurredAt: "t1", taskId: "t1", name: "line-cut" as const, details: { branch: "fabrica/t1" } },
  { occurredAt: "t2", taskId: "t1", name: "work-started" as const, details: { project: "/p" } },
  { occurredAt: "t3", taskId: "t1", name: "heartbeat" as const, details: { attempt: 1 } },
  { occurredAt: "t4", taskId: "t1", name: "task-failed" as const, details: { message: "the round threw" } },
];

test("stateOf: nothing a dead round leaves behind puts it back to working", () => {
  // Every event a second process holding this task id, or a round on its
  // way down, could still append. A round appends "task-failed" from the
  // top of its own stack, so none of these is evidence of a live worker.
  const strays = [
    "heartbeat",
    "work-started",
    "check-run",
    "inspector-called",
    "inspection-finished",
    "inspection-skipped",
    "line-cut",
    "receipt-recorded",
    "questions-asked",
    "pr-opened",
    "network-refused",
  ] as const;

  for (const name of strays) {
    assert.equal(
      stateOf([...FAILED_ROUND, { occurredAt: "t5", taskId: "t1", name, details: { attempt: 2 } }]),
      "failed",
      `a "${name}" event after task-failed must not revive the task`
    );
  }
});

test("stateOf: a failure recorded for ask-failed is just as absorbing", () => {
  const asked = [
    { occurredAt: "t0", taskId: "t1", name: "task-received" as const },
    { occurredAt: "t1", taskId: "t1", name: "ask-failed" as const, details: { error: "no credential" } },
  ];
  assert.equal(stateOf([...asked, { occurredAt: "t2", taskId: "t1", name: "work-started" }]), "failed");
});

test("stateOf: the Client's own two restarts still take a failed task back", () => {
  // Both are recorded in the foreground, before the round is handed to a
  // detached process (issue #123), so a genuine restart always puts one
  // of them on the record ahead of that round's own events.
  assert.equal(
    stateOf([
      ...FAILED_ROUND,
      { occurredAt: "t5", taskId: "t1", name: "answers-given", details: { answer: "yes" } },
      { occurredAt: "t6", taskId: "t1", name: "work-started", details: { project: "/p" } },
      { occurredAt: "t7", taskId: "t1", name: "check-run", details: { attempt: 2, phase: "started" } },
    ]),
    "checking"
  );
  assert.equal(
    stateOf([
      ...FAILED_ROUND,
      { occurredAt: "t5", taskId: "t1", name: "verdict-recorded", details: { ruling: "fix" } },
      { occurredAt: "t6", taskId: "t1", name: "work-started", details: { project: "/p" } },
    ]),
    "working"
  );
  // Issue #143: "wrong" is the one ruling that closes a task which never
  // reached a delivery - it has to get through the failure too.
  assert.equal(
    stateOf([...FAILED_ROUND, { occurredAt: "t5", taskId: "t1", name: "verdict-recorded", details: { ruling: "wrong" } }]),
    "closed"
  );
});

test("stateOf: a delivery that lands after a failure is still the Client's to rule on", () => {
  // Two rounds can hold one task id at once (`fabrica verdict` and the
  // live view's /review page record-then-spawn the same way), and a
  // round that delivers has not thrown - so this is never a straggler.
  assert.equal(
    stateOf([...FAILED_ROUND, { occurredAt: "t5", taskId: "t1", name: "delivered", details: { outcome: "done" } }]),
    "delivered"
  );
});

test("stateOf: a cap refusal of a first start is absorbing the same way", () => {
  const refused = [
    { occurredAt: "t0", taskId: "t1", name: "task-received" as const },
    { occurredAt: "t1", taskId: "t1", name: "cap-refused" as const, details: { message: "over the daily cap" } },
  ];
  assert.equal(stateOf([...refused, { occurredAt: "t2", taskId: "t1", name: "heartbeat" }]), "failed");
  assert.equal(
    stateOf([
      ...refused,
      { occurredAt: "t2", taskId: "t1", name: "answers-given", details: { answer: "yes" } },
      { occurredAt: "t3", taskId: "t1", name: "work-started", details: { project: "/p" } },
    ]),
    "working"
  );
});
