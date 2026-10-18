import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, appendFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendEvent, recordPath, registerTask } from "../../src/record/index.ts";
import {
  createRecordView,
  displayState,
  gateStateLabel,
  inspectorReportDetail,
  inspectorStampLabel,
  isFinished,
  questionsFromEvents,
  taskTitle,
} from "./record-view.ts";
import type { FabricaEvent } from "../../src/index.ts";

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

test("taskTitle: the write-up title wins once there is one, trimmed", () => {
  assert.equal(taskTitle("the raw task text", "  Fix the flaky retry  "), "Fix the flaky retry");
});

test("taskTitle: falls back to the task text's first line, cut to about 60 characters", () => {
  assert.equal(taskTitle("fix the bug\nmore detail below", undefined), "fix the bug");
  const long = "a".repeat(80);
  const cut = taskTitle(long, undefined);
  assert.ok(cut.length <= 61, "the fallback title stays short");
  assert.ok(cut.endsWith("…"), "a cut title is marked, not silently truncated");
});

test("taskTitle: an empty write-up title is treated as none, not shown as a blank title", () => {
  assert.equal(taskTitle("fix the bug", "   "), "fix the bug");
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

test("createRecordView: a delivered task's write-up becomes the row's title and is carried whole on the task view", () => {
  const recordHome = tempRecordHome();
  const view = createRecordView(recordHome);
  const taskId = registerTask(recordHome, "fix the thing that is broken").id;
  appendEvent(recordHome, { taskId, name: "work-started", details: { project: "/p" } });
  const writeup = { title: "Fix the broken thing", what: "w", why: "y", how: "h", deviations: "None." };
  appendEvent(recordHome, { taskId, name: "delivered", details: { outcome: "done", writeup } });

  const task = view.getState().tasks.find((t) => t.id === taskId);
  assert.equal(task?.title, "Fix the broken thing");
  assert.deepEqual(task?.writeup, writeup);
});

test("createRecordView: before any write-up exists, the row's title falls back to the task text and writeup reads null", () => {
  const recordHome = tempRecordHome();
  const view = createRecordView(recordHome);
  const taskId = registerTask(recordHome, "still working on it").id;
  appendEvent(recordHome, { taskId, name: "work-started", details: { project: "/p" } });

  const task = view.getState().tasks.find((t) => t.id === taskId);
  assert.equal(task?.title, "still working on it");
  assert.equal(task?.writeup, null);
});

test("createRecordView: getTask returns the same view getState would, for one task id", () => {
  const recordHome = tempRecordHome();
  const view = createRecordView(recordHome);
  const taskId = registerTask(recordHome, "look at just this one").id;
  appendEvent(recordHome, { taskId, name: "work-started", details: { project: "/p" } });

  assert.deepEqual(view.getTask(taskId), view.getState().tasks.find((t) => t.id === taskId));
});

test("createRecordView: getTask reads as null for a task id this record home has never heard of", () => {
  const view = createRecordView(tempRecordHome());
  assert.equal(view.getTask("20260101-ghost-zz"), null);
});

function fakeDelivery(overrides: Partial<Parameters<typeof inspectorStampLabel>[0] & Record<string, unknown>> = {}) {
  return {
    outcome: "done",
    confidence: 80,
    summary: "s",
    evidence: "e",
    assumptions: "a",
    gaps: "g",
    branch: "fabrica/t1",
    files: [],
    gateChanges: "",
    ...overrides,
  } as NonNullable<Parameters<typeof inspectorStampLabel>[0]>;
}

test("inspectorStampLabel: no delivery record at all", () => {
  assert.equal(inspectorStampLabel(null), "no delivery record");
});

test("inspectorStampLabel: Inspector's own verdict wins when this delivery went through Inspector", () => {
  assert.equal(inspectorStampLabel(fakeDelivery({ inspection: { verdict: "green", report: "ok" } })), "green");
  assert.equal(inspectorStampLabel(fakeDelivery({ inspection: { verdict: "red", report: "broke it" } })), "red");
  assert.equal(inspectorStampLabel(fakeDelivery({ inspection: { verdict: "refused", report: "no token" } })), "refused");
});

test("inspectorStampLabel: no Inspector involved - self-tested wording, distinct from 'not-verified'", () => {
  assert.equal(inspectorStampLabel(fakeDelivery({ outcome: "done" })), "not inspected (self-tested, no Inspector)");
  assert.equal(inspectorStampLabel(fakeDelivery({ outcome: "not-verified" })), "not verified (worker's box could not run the check)");
});

test("inspectorReportDetail: null for green or for no Inspector at all, Inspector's own text for red/refused", () => {
  assert.equal(inspectorReportDetail(null), null);
  assert.equal(inspectorReportDetail(fakeDelivery({ inspection: { verdict: "green", report: "ok" } })), null);
  assert.equal(inspectorReportDetail(fakeDelivery({ outcome: "done" })), null);
  assert.equal(inspectorReportDetail(fakeDelivery({ inspection: { verdict: "red", report: "the check failed" } })), "the check failed");
  assert.equal(inspectorReportDetail(fakeDelivery({ inspection: { verdict: "refused", report: "GITHUB_TOKEN is missing" } })), "GITHUB_TOKEN is missing");
});

test("gateStateLabel: no delivery record, empty declaration, and a real declared change", () => {
  assert.equal(gateStateLabel(null), "unknown");
  assert.equal(gateStateLabel(fakeDelivery({ gateChanges: "" })), "untouched");
  assert.equal(gateStateLabel(fakeDelivery({ gateChanges: "  " })), "untouched");
  assert.equal(gateStateLabel(fakeDelivery({ gateChanges: "loosened the check's timeout" })), "loosened the check's timeout");
});

test("createRecordView: getReviewRows shows only delivered tasks, with the real pull request write-up, Inspector's stamp, and the gate's state", () => {
  const recordHome = tempRecordHome();
  const view = createRecordView(recordHome);

  const working = registerTask(recordHome, "still going").id;
  appendEvent(recordHome, { taskId: working, name: "work-started", details: { project: "/p" } });

  const delivered = registerTask(recordHome, "ship the thing").id;
  appendEvent(recordHome, { taskId: delivered, name: "work-started", details: { project: "/p" } });
  const writeup = {
    title: "Ship the thing",
    why: "because",
    what: "did the thing",
    how: "carefully",
    outsideChanges: "None.",
    confidence: 90,
    assumptions: "none",
    expectedOutcomes: "it ships",
    deviations: "None.",
  };
  appendEvent(recordHome, {
    taskId: delivered,
    name: "delivered",
    details: {
      outcome: "done",
      writeup,
      delivery: fakeDelivery({ gateChanges: "", inspection: { verdict: "green", report: "all good" } }),
    },
  });
  appendEvent(recordHome, { taskId: delivered, name: "pr-opened", details: { url: "https://github.com/x/y/pull/1" } });

  const closed = registerTask(recordHome, "already ruled on").id;
  appendEvent(recordHome, { taskId: closed, name: "work-started", details: { project: "/p" } });
  appendEvent(recordHome, { taskId: closed, name: "delivered", details: { outcome: "done", delivery: fakeDelivery() } });
  appendEvent(recordHome, { taskId: closed, name: "verdict-recorded", details: { ruling: "accept" } });

  const rows = view.getReviewRows();
  assert.deepEqual(rows.map((r) => r.id), [delivered]);

  const row = rows[0];
  assert.equal(row.kind, "delivered");
  if (row.kind !== "delivered") throw new Error("unreachable");
  assert.equal(row.title, "Ship the thing");
  assert.equal(row.inspectorStamp, "green");
  assert.equal(row.inspectorDetail, null);
  assert.equal(row.gateState, "untouched");
  assert.equal(row.prUrl, "https://github.com/x/y/pull/1");
  assert.equal(row.writeupOk, true);
  assert.match(row.writeupBody, /## Description \(What\)\n\ndid the thing/);
  assert.match(row.writeupBody, /## Context \(Why\)\n\nbecause/);
  assert.match(row.writeupBody, /## Changes in the codebase \(How\)\n\ncarefully/);
  assert.match(row.writeupBody, /## Changes outside the codebase\n\nNone\./);
});

test("questionsFromEvents: the latest questions-asked wins, and a details shape that isn't a list of questions reads as none", () => {
  const event = (name: string, details: unknown): FabricaEvent =>
    ({ taskId: "t", name, occurredAt: "2026-10-17T00:00:00.000Z", details } as unknown as FabricaEvent);

  assert.deepEqual(questionsFromEvents([]), []);
  assert.deepEqual(questionsFromEvents([event("work-started", { project: "/p" })]), []);
  assert.deepEqual(questionsFromEvents([event("questions-asked", { questions: ["one?", "two?"] })]), ["one?", "two?"]);
  // A second round of questions (a resumed task that asked again) - the
  // latest is the one waiting on an answer.
  assert.deepEqual(
    questionsFromEvents([
      event("questions-asked", { questions: ["old?"] }),
      event("answers-given", { answer: "yes" }),
      event("questions-asked", { questions: ["new?"] }),
    ]),
    ["new?"]
  );
  // Defensive: this is a viewer, so a malformed event reads as no
  // questions rather than taking the page down.
  assert.deepEqual(questionsFromEvents([event("questions-asked", { questions: "one?" })]), []);
  assert.deepEqual(questionsFromEvents([event("questions-asked", undefined)]), []);
  assert.deepEqual(questionsFromEvents([event("questions-asked", { questions: ["ok?", 7] })]), ["ok?"]);
});

test("createRecordView: getReviewRows shows a task waiting on an answer, with its questions, and drops it once answered", () => {
  const recordHome = tempRecordHome();
  const view = createRecordView(recordHome);

  const asking = registerTask(recordHome, "build the thing").id;
  appendEvent(recordHome, {
    taskId: asking,
    name: "questions-asked",
    details: { questions: ["which database?", "ship behind a flag?"], project: "/p", totalAttempts: 2, explicitAttempts: false },
  });

  const rows = view.getReviewRows();
  assert.deepEqual(rows.map((r) => r.id), [asking]);
  const row = rows[0];
  assert.equal(row.kind, "asking");
  if (row.kind !== "asking") throw new Error("unreachable");
  assert.equal(row.title, "build the thing");
  assert.deepEqual(row.questions, ["which database?", "ship behind a flag?"]);

  // Answered: back to working, so nothing is waiting on the Client.
  appendEvent(recordHome, { taskId: asking, name: "answers-given", details: { answer: "postgres, no flag" } });
  assert.deepEqual(view.getReviewRows(), []);
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
