import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, appendFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendEvent, recordPath, registerTask } from "../../src/record/index.ts";
import { createRecordView, displayState, isFinished } from "./record-view.ts";

function tempRecordHome(): string {
  return mkdtempSync(join(tmpdir(), "fabrica-live-view-test-"));
}

test("displayState: collapses FabricaTask's richer union, but keeps a closed verdict's own ruling rather than folding it into 'stopped'", () => {
  assert.equal(displayState("asking"), "asked a question");
  assert.equal(displayState("working"), "working");
  assert.equal(displayState("checking"), "working");
  assert.equal(displayState("delivered"), "delivered");
  assert.equal(displayState("failed"), "failed");
  // "stopped" is reserved for a task that was actually stopped
  // (Inspector reaching no verdict at all) - a closed verdict shows the
  // ruling the Client actually gave instead.
  assert.equal(displayState("refused"), "stopped");
  assert.equal(displayState("closed", "accept"), "closed (accept)");
  assert.equal(displayState("closed", "wrong"), "closed (wrong)");
  // Defensive only - stateOf never reports "closed" without one of the
  // two rulings above behind it.
  assert.equal(displayState("closed"), "closed");
  assert.equal(displayState("closed", null), "closed");
});

test("isFinished: a closed verdict, a real stop, or a failure all count as history; nothing still moving does", () => {
  assert.equal(isFinished("working"), false);
  assert.equal(isFinished("asked a question"), false);
  assert.equal(isFinished("delivered"), false);
  assert.equal(isFinished("failed"), true);
  assert.equal(isFinished("stopped"), true);
  assert.equal(isFinished("closed (accept)"), true);
  assert.equal(isFinished("closed (wrong)"), true);
  assert.equal(isFinished("closed"), true);
});

test("createRecordView: an unregistered record home reads as empty, not an error", () => {
  const recordHome = join(tempRecordHome(), "never-created");
  const view = createRecordView(recordHome);
  const state = view.getState(1000);
  assert.deepEqual(state.tasks, []);
  assert.equal(state.spend.dailyUsd, 0);
});

test("createRecordView: a record home with no tasks yet reads as empty", () => {
  const view = createRecordView(tempRecordHome());
  assert.deepEqual(view.getState().tasks, []);
});

test("createRecordView: renders a task in every one of the displayed states", () => {
  const recordHome = tempRecordHome();
  const view = createRecordView(recordHome);

  const asking = registerTask(recordHome, "ask me something").id;
  appendEvent(recordHome, { taskId: asking, name: "questions-asked", details: { questions: ["q1?"] } });

  const working = registerTask(recordHome, "do something").id;
  appendEvent(recordHome, { taskId: working, name: "work-started", details: { project: "/p" } });

  const delivered = registerTask(recordHome, "deliver something").id;
  appendEvent(recordHome, { taskId: delivered, name: "work-started", details: { project: "/p" } });
  appendEvent(recordHome, { taskId: delivered, name: "delivered", details: { outcome: "done" } });

  const failed = registerTask(recordHome, "fail to ask").id;
  appendEvent(recordHome, { taskId: failed, name: "ask-failed", details: { error: "no credentials" } });

  const acceptedByVerdict = registerTask(recordHome, "accept me").id;
  appendEvent(recordHome, { taskId: acceptedByVerdict, name: "work-started", details: { project: "/p" } });
  appendEvent(recordHome, { taskId: acceptedByVerdict, name: "delivered", details: { outcome: "done" } });
  appendEvent(recordHome, { taskId: acceptedByVerdict, name: "verdict-recorded", details: { ruling: "accept" } });

  const wrongedByVerdict = registerTask(recordHome, "wrong me").id;
  appendEvent(recordHome, { taskId: wrongedByVerdict, name: "work-started", details: { project: "/p" } });
  appendEvent(recordHome, { taskId: wrongedByVerdict, name: "delivered", details: { outcome: "done" } });
  appendEvent(recordHome, { taskId: wrongedByVerdict, name: "verdict-recorded", details: { ruling: "wrong" } });

  const actuallyStopped = registerTask(recordHome, "refuse me").id;
  appendEvent(recordHome, { taskId: actuallyStopped, name: "work-started", details: { project: "/p" } });
  appendEvent(recordHome, { taskId: actuallyStopped, name: "inspection-finished", details: { verdict: "refused" } });

  const byId = new Map(view.getState().tasks.map((t) => [t.id, t]));
  assert.equal(byId.get(asking)?.state, "asked a question");
  assert.equal(byId.get(working)?.state, "working");
  assert.equal(byId.get(delivered)?.state, "delivered");
  assert.equal(byId.get(failed)?.state, "failed");
  assert.equal(byId.get(acceptedByVerdict)?.state, "closed (accept)");
  assert.equal(byId.get(wrongedByVerdict)?.state, "closed (wrong)");
  assert.equal(byId.get(actuallyStopped)?.state, "stopped");

  assert.equal(byId.get(asking)?.finished, false);
  assert.equal(byId.get(working)?.finished, false);
  assert.equal(byId.get(delivered)?.finished, false);
  assert.equal(byId.get(failed)?.finished, true);
  assert.equal(byId.get(acceptedByVerdict)?.finished, true);
  assert.equal(byId.get(wrongedByVerdict)?.finished, true);
  assert.equal(byId.get(actuallyStopped)?.finished, true);
});

test("createRecordView: a malformed line in events.jsonl is skipped, not thrown, and later valid events still land", () => {
  const recordHome = tempRecordHome();
  const taskId = registerTask(recordHome, "survive corruption").id;
  appendEvent(recordHome, { taskId, name: "work-started", details: { project: "/p" } });

  // A complete, syntactically invalid JSON line - not the documented
  // trailing-partial-write case readEvents.ts already tolerates, but an
  // outright corrupt one (e.g. a byte flipped on disk).
  appendFileSync(recordPath(recordHome), "{not valid json at all\n");

  appendEvent(recordHome, { taskId, name: "delivered", details: { outcome: "done" } });

  const view = createRecordView(recordHome);
  assert.doesNotThrow(() => view.getState());

  const task = view.getState().tasks.find((t) => t.id === taskId);
  assert.ok(task, "the task survived the corrupt line");
  assert.equal(task?.state, "delivered");
});

test("createRecordView: finished tasks sort newest-first", async () => {
  const recordHome = tempRecordHome();
  const view = createRecordView(recordHome);

  const older = registerTask(recordHome, "older task").id;
  appendEvent(recordHome, { taskId: older, name: "ask-failed", details: { error: "x" } });

  // appendEvent always stamps its own timestamp (append.ts), so the two
  // tasks' events need a real gap between them to land in a guaranteed
  // order - Date.now()'s own resolution otherwise risks a tie.
  await new Promise((resolve) => setTimeout(resolve, 5));

  const newer = registerTask(recordHome, "newer task").id;
  appendEvent(recordHome, { taskId: newer, name: "ask-failed", details: { error: "x" } });

  const ids = view.getState().tasks.filter((t) => t.finished).map((t) => t.id);
  assert.deepEqual(ids, [newer, older]);
});

test("createRecordView: never writes to the record home", () => {
  const recordHome = tempRecordHome();
  const taskId = registerTask(recordHome, "read only").id;
  appendEvent(recordHome, { taskId, name: "work-started", details: { project: "/p" } });

  const before = readFileSync(recordPath(recordHome), "utf8");
  const view = createRecordView(recordHome);
  view.getState();
  view.getState();
  view.getTranscript(taskId);
  const after = readFileSync(recordPath(recordHome), "utf8");

  assert.equal(after, before);
});
