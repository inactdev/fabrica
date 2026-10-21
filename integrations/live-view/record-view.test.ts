import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, appendFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendEvent, appendTaskFile, recordPath, registerTask, writeTaskFile } from "../../src/record/index.ts";
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
  // Issue #203: the Client stopping a task himself is its own word -
  // "stopped" above has meant "Inspector reached no verdict" since
  // issue #26, and two outcomes reading as one word on one page would
  // be worse than a longer label.
  assert.equal(displayState("stopped"), "stopped by you");
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
  assert.equal(isFinished("stopped by you"), true);
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

  // Both are given the same `now` (issue #203 added a live `durationMs`
  // to this shape): left to their own defaults they would read the
  // clock a fraction of a millisecond apart, and the one field that is
  // meant to differ over time would make this comparison flaky for a
  // reason that has nothing to do with what it is proving.
  const now = Date.now();
  assert.deepEqual(view.getTask(taskId, now), view.getState(now).tasks.find((t) => t.id === taskId));
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
    quiz: [
      { question: "What changed?", answer: "The thing this test is about." },
      { question: "Why?", answer: "So the write-up is valid." },
      { question: "What should the owner watch?", answer: "Nothing - this is a test." },
    ],
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
  // Issue #98: the worker's quiz rides on the row as data, not folded
  // into writeupBody - the page needs the answers separately to keep
  // them hidden until one is tapped.
  assert.deepEqual(row.quiz, writeup.quiz);
  assert.ok(!row.writeupBody.includes("What changed?"), "the quiz must not be rendered into the pull request body");
});

// Issue #98: the /quiz page. Accepted tasks only - the one list here
// that is deliberately about tasks NOT waiting on the Client - newest
// acceptance first, capped at ten, and a task whose write-up predates
// the field is skipped rather than listed with nothing in it.
test("createRecordView: getQuizRows lists the last ten accepted tasks' quizzes, newest first, skipping those with none", () => {
  const recordHome = tempRecordHome();
  const view = createRecordView(recordHome);
  const quizFor = (n: number) => [
    { question: `q1 of ${n}`, answer: `a1 of ${n}` },
    { question: `q2 of ${n}`, answer: `a2 of ${n}` },
    { question: `q3 of ${n}`, answer: `a3 of ${n}` },
  ];

  /** One task delivered and then ruled on, in that order. The verdict
   * event is appended by hand rather than through `appendEvent` for one
   * reason: it stamps its own `occurredAt` (append.ts), and this test
   * needs twelve acceptances in a guaranteed order, which twelve
   * same-millisecond timestamps cannot give. The alternative the
   * newest-first test above uses - a real sleep between each - would be
   * twelve of them here. */
  function ruledTask(n: number, ruling: string, writeup: unknown): string {
    const id = registerTask(recordHome, `task ${n}`).id;
    appendEvent(recordHome, { taskId: id, name: "work-started", details: { project: "/p" } });
    appendEvent(recordHome, {
      taskId: id,
      name: "delivered",
      details: { outcome: "done", ...(writeup === undefined ? {} : { writeup }), delivery: fakeDelivery() },
    });
    const occurredAt = new Date(Date.UTC(2026, 9, 1, 12, n)).toISOString();
    appendFileSync(
      recordPath(recordHome),
      `${JSON.stringify({ taskId: id, name: "verdict-recorded", occurredAt, details: { ruling } })}\n`
    );
    return id;
  }

  const base = {
    why: "w",
    what: "w",
    how: "w",
    outsideChanges: "None.",
    confidence: 80,
    assumptions: "None.",
    expectedOutcomes: "o",
    deviations: "None.",
  };

  // Twelve accepted tasks, appended oldest first, so the two oldest fall
  // off the end of the ten this page keeps.
  const accepted: string[] = [];
  for (let n = 1; n <= 12; n++) accepted.push(ruledTask(n, "accept", { ...base, title: `Task ${n}`, quiz: quizFor(n) }));

  // Three tasks that must never appear: ruled "wrong", still waiting on
  // a verdict, and accepted but with no quiz on its write-up at all (the
  // pre-issue-#98 record, which is never backfilled).
  const wrong = ruledTask(13, "wrong", { ...base, title: "Task 13", quiz: quizFor(13) });
  const stillDelivered = registerTask(recordHome, "task 14").id;
  appendEvent(recordHome, { taskId: stillDelivered, name: "work-started", details: { project: "/p" } });
  appendEvent(recordHome, {
    taskId: stillDelivered,
    name: "delivered",
    details: { outcome: "done", writeup: { ...base, title: "Task 14", quiz: quizFor(14) }, delivery: fakeDelivery() },
  });
  const noQuiz = ruledTask(15, "accept", { ...base, title: "Task 15" });

  const rows = view.getQuizRows();

  assert.equal(rows.length, 10, "the page keeps exactly the last ten");
  assert.deepEqual(
    rows.map((r) => r.id),
    [...accepted].reverse().slice(0, 10),
    "newest acceptance first, oldest two dropped"
  );
  for (const id of [wrong, stillDelivered, noQuiz]) {
    assert.ok(!rows.some((r) => r.id === id), `${id} must not appear on the quiz page`);
  }
  assert.deepEqual(rows[0].quiz, quizFor(12));
  assert.equal(rows[0].title, "Task 12");
  assert.ok(rows[0].acceptedAtMs > 0, "the row must carry when it was accepted");
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

// --- the full column set (issue #203) ---------------------------------
//
// Every column the list pages now show has to come off the record and
// nothing else. These tests build the record by hand, event by event,
// because that is exactly the question being asked: given these events,
// what does the page say?

/** A receipt as attempts.ts records one, with only the fields these
 * columns read filled in. */
function receiptEvent(recordHome: string, taskId: string, receipt: Record<string, unknown>): void {
  appendEvent(recordHome, { taskId, name: "receipt-recorded", details: { receipt } });
}

test("worker and model come off the latest receipt, and read as nothing before there is one", () => {
  const recordHome = tempRecordHome();
  const { id } = registerTask(recordHome, "a task");
  appendEvent(recordHome, { taskId: id, name: "work-started", details: { project: "/proj/thing" } });

  assert.equal(createRecordView(recordHome).getTask(id)!.worker, null, "no attempt yet, so nothing to claim");

  receiptEvent(recordHome, id, { attempt: 1, brain: "claude-code", model: "old-model" });
  receiptEvent(recordHome, id, { attempt: 2, brain: "claude-code", model: "new-model" });

  assert.equal(createRecordView(recordHome).getTask(id)!.worker, "claude-code · new-model");
});

test("a receipt carried only on a delivered event's own list is still found", () => {
  const recordHome = tempRecordHome();
  const { id } = registerTask(recordHome, "a task");
  appendEvent(recordHome, {
    taskId: id,
    name: "delivered",
    details: { outcome: "done", receipts: [{ attempt: 1, brain: "some-brain", model: "some-model" }] },
  });

  assert.equal(createRecordView(recordHome).getTask(id)!.worker, "some-brain · some-model");
});

test("network policy says only what the record can say: nothing, or the refusals it holds", () => {
  const recordHome = tempRecordHome();
  const { id } = registerTask(recordHome, "a task");
  appendEvent(recordHome, { taskId: id, name: "work-started", details: { project: "/p" } });

  // Fabrica records no per-task network policy today (the adapter picks
  // one per call and nothing writes it down - see networkPolicyLabel),
  // so this must not claim one.
  assert.equal(createRecordView(recordHome).getTask(id)!.networkPolicy, "not recorded");

  appendEvent(recordHome, { taskId: id, name: "network-refused", details: { host: "evil.example", port: 443 } });
  appendEvent(recordHome, { taskId: id, name: "network-refused", details: { host: "evil.example", port: 443 } });
  assert.equal(createRecordView(recordHome).getTask(id)!.networkPolicy, "2 refused (evil.example)");
});

test("trigger names the round the task is on, and the issue it was given explicitly", () => {
  const recordHome = tempRecordHome();
  const { id } = registerTask(recordHome, "a task");
  appendEvent(recordHome, { taskId: id, name: "work-started", details: { project: "/p" } });
  assert.equal(createRecordView(recordHome).getTask(id)!.trigger, "do");

  appendEvent(recordHome, { taskId: id, name: "answers-given", details: {} });
  assert.equal(createRecordView(recordHome).getTask(id)!.trigger, "answer");

  appendEvent(recordHome, { taskId: id, name: "verdict-recorded", details: { ruling: "fix" } });
  appendEvent(recordHome, { taskId: id, name: "verdict-recorded", details: { ruling: "fix" } });
  assert.equal(createRecordView(recordHome).getTask(id)!.trigger, "fix 2");
});

test("an explicitly named issue rides along with the trigger", () => {
  const recordHome = tempRecordHome();
  const { id } = registerTask(recordHome, "a task");
  writeTaskFile(recordHome, id, "issue", "203");
  appendEvent(recordHome, { taskId: id, name: "work-started", details: { project: "/p" } });

  assert.equal(createRecordView(recordHome).getTask(id)!.trigger, "do #203");
});

test("started and duration come from the task's own first and last events", () => {
  const recordHome = tempRecordHome();
  const { id } = registerTask(recordHome, "a task");
  appendEvent(recordHome, { taskId: id, name: "work-started", details: { project: "/p" } });

  const view = createRecordView(recordHome);
  const started = view.getTask(id)!.startedAtMs!;
  assert.ok(Number.isFinite(started), "a registered task always has a start");

  // An open task's duration runs to now...
  const open = view.getTask(id, started + 90_000)!;
  assert.equal(open.durationMs, 90_000);

  // ...and a finished one's stops at whatever it last recorded, rather
  // than counting up forever on the history page.
  appendEvent(recordHome, { taskId: id, name: "delivered", details: { outcome: "done" } });
  appendEvent(recordHome, { taskId: id, name: "verdict-recorded", details: { ruling: "accept" } });
  const closed = createRecordView(recordHome).getTask(id, started + 10 * 60_000)!;
  assert.ok(closed.finished);
  assert.ok(closed.durationMs < 60_000, "a closed task's duration is frozen, not still running");
});

test("checks reports whatever most recently judged the work, Inspector included", () => {
  const recordHome = tempRecordHome();
  const { id } = registerTask(recordHome, "a task");
  appendEvent(recordHome, { taskId: id, name: "work-started", details: { project: "/p" } });
  assert.equal(createRecordView(recordHome).getTask(id)!.checks, "—");

  appendEvent(recordHome, { taskId: id, name: "check-run", details: { attempt: 1, phase: "started" } });
  assert.equal(createRecordView(recordHome).getTask(id)!.checks, "running");

  appendEvent(recordHome, { taskId: id, name: "check-run", details: { attempt: 1, green: false } });
  assert.equal(createRecordView(recordHome).getTask(id)!.checks, "red");

  appendEvent(recordHome, { taskId: id, name: "inspection-finished", details: { verdict: "green", report: "" } });
  assert.equal(createRecordView(recordHome).getTask(id)!.checks, "inspector: green");
});

test("delivery and confidence come off the real Delivery, and an Inspector refusal after it supersedes it", () => {
  const recordHome = tempRecordHome();
  const { id } = registerTask(recordHome, "a task");
  appendEvent(recordHome, { taskId: id, name: "work-started", details: { project: "/p" } });
  assert.equal(createRecordView(recordHome).getTask(id)!.delivery, null);
  assert.equal(createRecordView(recordHome).getTask(id)!.confidence, null);

  appendEvent(recordHome, {
    taskId: id,
    name: "delivered",
    details: { outcome: "done", delivery: { outcome: "done", confidence: 100, summary: "s" } },
  });
  assert.equal(createRecordView(recordHome).getTask(id)!.delivery, "done");
  assert.equal(createRecordView(recordHome).getTask(id)!.confidence, 100);

  appendEvent(recordHome, { taskId: id, name: "inspection-finished", details: { verdict: "refused", report: "no token" } });
  assert.equal(createRecordView(recordHome).getTask(id)!.delivery, null, "a refusal after a delivery supersedes it");
});

test("the cost meter's cap is the one the task started under, not whatever projects.toml says now", () => {
  const recordHome = tempRecordHome();
  const { id } = registerTask(recordHome, "a task");
  writeTaskFile(recordHome, id, "caps.json", JSON.stringify({ perTaskUsd: 3 }));
  appendEvent(recordHome, { taskId: id, name: "work-started", details: { project: "/p" } });

  assert.equal(createRecordView(recordHome).getTask(id)!.perTaskCapUsd, 3);
});

test("a task registered before caps were ever recorded shows no cap rather than a wrong one", () => {
  const recordHome = tempRecordHome();
  const { id } = registerTask(recordHome, "a task");
  appendEvent(recordHome, { taskId: id, name: "work-started", details: { project: "/p" } });

  // No caps.json, and no projects.toml in this throwaway record home
  // either - so there is no cap, and the page shows the cost as plain
  // text with no meter.
  assert.equal(createRecordView(recordHome).getTask(id)!.perTaskCapUsd, undefined);
});

test("a caps.json that cannot be parsed falls back rather than taking the page down", () => {
  const recordHome = tempRecordHome();
  const { id } = registerTask(recordHome, "a task");
  writeTaskFile(recordHome, id, "caps.json", "{ not json");
  appendEvent(recordHome, { taskId: id, name: "work-started", details: { project: "/p" } });

  assert.equal(createRecordView(recordHome).getTask(id)!.perTaskCapUsd, undefined);
});

test("getRunningRows lists exactly the stoppable tasks, with the worker's own last line", () => {
  const recordHome = tempRecordHome();

  const { id: running } = registerTask(recordHome, "still going");
  appendEvent(recordHome, { taskId: running, name: "work-started", details: { project: "/p" } });
  appendTaskFile(
    recordHome,
    running,
    "transcript.log",
    `${JSON.stringify({ occurredAt: "2026-10-18T10:00:00.000Z", kind: "stdout", text: "editing a file" })}\n`
  );

  const { id: delivered } = registerTask(recordHome, "already done");
  appendEvent(recordHome, { taskId: delivered, name: "work-started", details: { project: "/p" } });
  appendEvent(recordHome, { taskId: delivered, name: "delivered", details: { outcome: "done" } });

  const { id: asking } = registerTask(recordHome, "waiting on words");
  appendEvent(recordHome, { taskId: asking, name: "questions-asked", details: { questions: ["which?"] } });

  const rows = createRecordView(recordHome).getRunningRows();

  assert.deepEqual(rows.map((r) => r.id), [running], "only the one that is actually running");
  assert.equal(rows[0].lastActivity, "editing a file");
  assert.equal(rows[0].title, "still going");
});

test("a task mid-check is running too - it is the same 'working' word on this page", () => {
  const recordHome = tempRecordHome();
  const { id } = registerTask(recordHome, "checking away");
  appendEvent(recordHome, { taskId: id, name: "work-started", details: { project: "/p" } });
  appendEvent(recordHome, { taskId: id, name: "check-run", details: { attempt: 1, phase: "started" } });

  assert.deepEqual(createRecordView(recordHome).getRunningRows().map((r) => r.id), [id]);
});

test("a task the Client stopped is finished, not running, and never waiting on him", () => {
  const recordHome = tempRecordHome();
  const { id } = registerTask(recordHome, "stopped one");
  appendEvent(recordHome, { taskId: id, name: "work-started", details: { project: "/p" } });
  appendEvent(recordHome, {
    taskId: id,
    name: "stopped-by-owner",
    details: { by: "client@example.com", stoppedFrom: "working", lastActivity: null },
  });

  const view = createRecordView(recordHome);
  const task = view.getTask(id)!;
  assert.equal(task.state, "stopped by you");
  assert.equal(task.finished, true);
  assert.equal(task.running, false);
  assert.deepEqual(view.getRunningRows(), []);
  assert.deepEqual(view.getReviewRows(), []);
});

// Issue #189: the two subscription meters on the phone review page -
// the one budget a flat-rate subscription's own spend figures cannot
// show, since filling the week costs no dollars.

function recordMeterReading(
  recordHome: string,
  taskId: string,
  meters: { observedAt: string; fiveHourPercent: number | null; sevenDayPercent: number | null }
): void {
  appendEvent(recordHome, { taskId, name: "task-received" });
  appendEvent(recordHome, {
    taskId,
    name: "receipt-recorded",
    details: {
      receipt: {
        task: taskId,
        attempt: 1,
        brain: "fake",
        model: "fake-1",
        startedAt: meters.observedAt,
        durationMs: 1,
        costUsd: 0,
        costUnknown: false,
        costBasis: "subscription-estimate",
        meters,
        session: null,
        reasoningEffort: null,
        checks: null,
        outcome: "delivered",
      },
    },
  });
}

test("getMeters: shows both windows, with what the pause rule makes of them", () => {
  const recordHome = tempRecordHome();
  const now = Date.now();
  const { id } = registerTask(recordHome, "a job");
  recordMeterReading(recordHome, id, {
    observedAt: new Date(now - 30_000).toISOString(),
    fiveHourPercent: 7,
    sevenDayPercent: 64,
  });

  const meters = createRecordView(recordHome).getMeters(now);
  assert.equal(meters.label, "5h 7%, 7d 64%");
  assert.equal(meters.paused, false);
  assert.equal(meters.detail, "");
});

test("getMeters: says new work is paused, with the reason, once the week is over its threshold", () => {
  const recordHome = tempRecordHome();
  const now = Date.now();
  const { id } = registerTask(recordHome, "a job");
  recordMeterReading(recordHome, id, {
    observedAt: new Date(now - 30_000).toISOString(),
    fiveHourPercent: 20,
    sevenDayPercent: 81,
  });

  const meters = createRecordView(recordHome).getMeters(now);
  assert.equal(meters.paused, true);
  assert.match(meters.detail, /81% of the 7-day window/);
});

test("getMeters: with no reading, says so and that the rule is refusing nothing", () => {
  const meters = createRecordView(tempRecordHome()).getMeters(Date.now());
  assert.equal(meters.label, "not read yet");
  assert.equal(meters.paused, false);
  assert.match(meters.detail, /refusing nothing/);
});

test("getMeters: a stale reading is shown but never acted on", () => {
  const recordHome = tempRecordHome();
  const now = Date.now();
  const { id } = registerTask(recordHome, "a job");
  recordMeterReading(recordHome, id, {
    observedAt: new Date(now - 8 * 60 * 60 * 1000).toISOString(),
    fiveHourPercent: 99,
    sevenDayPercent: 99,
  });

  const meters = createRecordView(recordHome).getMeters(now);
  assert.equal(meters.label, "5h 99%, 7d 99%");
  assert.equal(meters.paused, false);
  assert.match(meters.detail, /too stale/);
});
