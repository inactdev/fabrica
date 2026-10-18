import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendEvent, appendTaskFile, registerTask } from "../record/index.ts";
import { ForemanError } from "./errors.ts";
import { eventsOf, stateOf } from "./queries.ts";
import { recordStopDecision } from "./stop.ts";
import type { StoppedByOwnerDetails } from "./stop.ts";

function freshHome(): string {
  return mkdtempSync(join(tmpdir(), "fabrica-stop-home-"));
}

/** A task mid-work: registered, a worker started, two transcript lines
 * written the way `attempts.ts` writes them (one JSON entry per line). */
function workingTask(recordHome: string, lines: string[] = []): string {
  const { id } = registerTask(recordHome, "a task to stop");
  appendEvent(recordHome, { taskId: id, name: "work-started", details: { project: "/p" } });
  for (const [i, text] of lines.entries()) {
    appendTaskFile(
      recordHome,
      id,
      "transcript.log",
      `${JSON.stringify({ occurredAt: `2026-10-18T10:0${i}:00.000Z`, kind: "stdout", text })}\n`
    );
  }
  return id;
}

function detailsOf(recordHome: string, taskId: string): StoppedByOwnerDetails {
  const event = eventsOf(recordHome, taskId).filter((e) => e.name === "stopped-by-owner").at(-1);
  assert.ok(event, "a stopped-by-owner event must be on the record");
  return event!.details as StoppedByOwnerDetails;
}

test("a stop records who stopped it and the worker's last transcript line", () => {
  const recordHome = freshHome();
  const id = workingTask(recordHome, ["reading the brief", "editing src/thing.ts"]);

  const returned = recordStopDecision(recordHome, id, "owner@example.com");

  const details = detailsOf(recordHome, id);
  assert.deepEqual(returned, details, "what the call returns is exactly what went on the record");
  assert.equal(details.by, "owner@example.com");
  assert.equal(details.stoppedFrom, "working");
  assert.equal(details.lastActivity?.text, "editing src/thing.ts");
  assert.equal(details.lastActivity?.kind, "stdout");
  assert.equal(details.lastActivity?.occurredAt, "2026-10-18T10:01:00.000Z");
});

test("a worker stopped before its first transcript line records no last activity, rather than failing", () => {
  const recordHome = freshHome();
  const id = workingTask(recordHome);

  recordStopDecision(recordHome, id, "owner@example.com");

  assert.equal(detailsOf(recordHome, id).lastActivity, null);
});

test("the task is stopped the moment the event lands", () => {
  const recordHome = freshHome();
  const id = workingTask(recordHome);
  assert.equal(stateOf(eventsOf(recordHome, id)), "working");

  recordStopDecision(recordHome, id, "owner@example.com");

  assert.equal(stateOf(eventsOf(recordHome, id)), "stopped");
});

test("a task mid-check is stopped too, and the record says that is what was interrupted", () => {
  const recordHome = freshHome();
  const id = workingTask(recordHome);
  appendEvent(recordHome, { taskId: id, name: "check-run", details: { attempt: 1, phase: "started" } });
  assert.equal(stateOf(eventsOf(recordHome, id)), "checking");

  recordStopDecision(recordHome, id, "owner@example.com");

  assert.equal(detailsOf(recordHome, id).stoppedFrom, "checking");
  assert.equal(stateOf(eventsOf(recordHome, id)), "stopped");
});

test("nothing the dying process still appends can make a stopped task look alive again", () => {
  const recordHome = freshHome();
  const id = workingTask(recordHome);
  recordStopDecision(recordHome, id, "owner@example.com");

  // Everything a signaled round could plausibly still get out before it
  // goes down - including a whole delivery from work it had already
  // finished.
  appendEvent(recordHome, { taskId: id, name: "heartbeat", details: { attempt: 1 } });
  appendEvent(recordHome, { taskId: id, name: "check-run", details: { attempt: 1, green: true } });
  appendEvent(recordHome, { taskId: id, name: "delivered", details: { outcome: "done" } });
  appendEvent(recordHome, { taskId: id, name: "work-started", details: { project: "/p" } });

  assert.equal(stateOf(eventsOf(recordHome, id)), "stopped");
});

test("the Client's own verdict still closes a stopped task - his decision, not the machine's", () => {
  const recordHome = freshHome();
  const id = workingTask(recordHome);
  recordStopDecision(recordHome, id, "owner@example.com");
  appendEvent(recordHome, { taskId: id, name: "verdict-recorded", details: { ruling: "wrong" } });

  assert.equal(stateOf(eventsOf(recordHome, id)), "closed");
});

test("a fix verdict after a stop leaves it stopped - only accept/wrong ever close anything", () => {
  const recordHome = freshHome();
  const id = workingTask(recordHome);
  recordStopDecision(recordHome, id, "owner@example.com");
  appendEvent(recordHome, { taskId: id, name: "verdict-recorded", details: { ruling: "fix" } });

  assert.equal(stateOf(eventsOf(recordHome, id)), "stopped");
});

test("a task that is not running is refused, naming the state it is actually in", () => {
  const recordHome = freshHome();
  const { id } = registerTask(recordHome, "already delivered");
  appendEvent(recordHome, { taskId: id, name: "work-started", details: { project: "/p" } });
  appendEvent(recordHome, { taskId: id, name: "delivered", details: { outcome: "done" } });

  assert.throws(
    () => recordStopDecision(recordHome, id, "owner@example.com"),
    (err: unknown) => {
      assert.ok(err instanceof ForemanError);
      assert.equal(err.code, "not-running");
      assert.match(err.message, /is delivered, not running/);
      return true;
    }
  );
  assert.equal(
    eventsOf(recordHome, id).filter((e) => e.name === "stopped-by-owner").length,
    0,
    "a refused stop writes nothing at all"
  );
});

test("stopping an already-stopped task is refused rather than recorded twice", () => {
  const recordHome = freshHome();
  const id = workingTask(recordHome);
  recordStopDecision(recordHome, id, "owner@example.com");

  assert.throws(() => recordStopDecision(recordHome, id, "owner@example.com"), /is stopped, not running/);
  assert.equal(eventsOf(recordHome, id).filter((e) => e.name === "stopped-by-owner").length, 1);
});

test("a task this record home has never heard of is refused as unknown", () => {
  const recordHome = freshHome();

  assert.throws(
    () => recordStopDecision(recordHome, "task-nope", "owner@example.com"),
    (err: unknown) => {
      assert.ok(err instanceof ForemanError);
      assert.equal(err.code, "unknown-task");
      return true;
    }
  );
});
