// "A question must only be asked while it is still true" - the cheap,
// record-only half. On every accept, an earlier accepted task whose own
// work touched one of the same files has its questions marked.

import { test } from "node:test";
import assert from "node:assert/strict";
import { appendEvent, readEvents, readEventsForTask } from "../record/index.ts";

import { acceptedTask, fakeDelivery, quizRecordHome } from "./helpers/fixture.ts";
import { appendQuizRecheck } from "./events.ts";
import { quizQuestionsForTask } from "./questions.ts";
import { deliveredFilesOf, markQuestionsOutdatedBy } from "./staleness.ts";

function statusesOf(recordHome: string, taskId: string): string[] {
  return quizQuestionsForTask(taskId, readEventsForTask(recordHome, taskId), Date.now()).map((q) => q.status);
}

function mark(recordHome: string, acceptedId: string): string[] {
  return markQuestionsOutdatedBy(recordHome, acceptedId, readEvents(recordHome));
}

test("deliveredFilesOf reads the latest delivery's files, and a later refusal clears them", () => {
  const recordHome = quizRecordHome();
  const id = acceptedTask(recordHome, { title: "Ship it", files: ["a.ts", "b.ts"] });
  assert.deepEqual(deliveredFilesOf(readEventsForTask(recordHome, id)), ["a.ts", "b.ts"]);

  appendEvent(recordHome, { taskId: id, name: "inspection-finished", details: { verdict: "refused", report: "no" } });
  assert.deepEqual(deliveredFilesOf(readEventsForTask(recordHome, id)), []);
});

test("an accept marks the earlier accepted tasks that touched the same files, and only those", () => {
  const recordHome = quizRecordHome();
  const overlapping = acceptedTask(recordHome, { title: "Touched a.ts", files: ["a.ts", "x.ts"] });
  const elsewhere = acceptedTask(recordHome, { title: "Touched z.ts", files: ["z.ts"] });
  const newest = acceptedTask(recordHome, { title: "Touched a.ts again", files: ["a.ts", "y.ts"] });

  assert.deepEqual(mark(recordHome, newest), [overlapping]);
  assert.deepEqual(statusesOf(recordHome, overlapping), ["outdated", "outdated", "outdated"]);
  assert.deepEqual(statusesOf(recordHome, elsewhere), ["live", "live", "live"]);
  assert.deepEqual(statusesOf(recordHome, newest), ["live", "live", "live"], "a task never dates its own questions");
});

test("the mark names the later task and the files the two have in common, not everything either touched", () => {
  const recordHome = quizRecordHome();
  const older = acceptedTask(recordHome, { title: "Older", files: ["a.ts", "b.ts", "c.ts"] });
  const newer = acceptedTask(recordHome, { title: "Newer", files: ["b.ts", "c.ts", "d.ts"] });

  mark(recordHome, newer);
  const question = quizQuestionsForTask(older, readEventsForTask(recordHome, older), Date.now())[0];
  assert.deepEqual(question.staleBecause, { touchedBy: newer, files: ["b.ts", "c.ts"] });
});

test("a task with nothing live to mark is left alone, so repeated accepts don't pile up identical marks", () => {
  const recordHome = quizRecordHome();
  const older = acceptedTask(recordHome, { title: "Older", files: ["a.ts"] });
  const first = acceptedTask(recordHome, { title: "First", files: ["a.ts"] });
  const second = acceptedTask(recordHome, { title: "Second", files: ["a.ts"] });

  assert.deepEqual(mark(recordHome, first), [older]);
  // `older` is already outdated, and `first`'s own questions are live, so
  // the second accept has exactly one task left to mark.
  assert.deepEqual(mark(recordHome, second), [first]);

  // Once a re-check has answered for `older`, a further accept can date
  // it again - that is the point of the mark being re-earnable. `first`
  // is not marked again: it is still outdated from the accept above, and
  // nothing has answered for it yet.
  appendQuizRecheck(recordHome, older, { index: 0, outcome: "confirmed" });
  appendQuizRecheck(recordHome, older, { index: 1, outcome: "confirmed" });
  appendQuizRecheck(recordHome, older, { index: 2, outcome: "confirmed" });
  const third = acceptedTask(recordHome, { title: "Third", files: ["a.ts"] });
  assert.deepEqual(mark(recordHome, third).sort(), [older, second].sort());
});

test("a task nobody accepted is neither marked nor able to mark anything", () => {
  const recordHome = quizRecordHome();
  const accepted = acceptedTask(recordHome, { title: "Accepted", files: ["a.ts"] });
  const pending = acceptedTask(recordHome, {
    title: "Still waiting",
    files: ["a.ts"],
    ruling: null as unknown as string,
  });

  assert.deepEqual(mark(recordHome, pending), [], "an unaccepted task's delivery dates nothing");
  assert.deepEqual(statusesOf(recordHome, accepted), ["live", "live", "live"]);

  assert.deepEqual(mark(recordHome, accepted), [], "and it has no questions of its own to be dated");
  assert.deepEqual(statusesOf(recordHome, pending), []);
});

test("an accept whose delivery lists no files at all dates nothing", () => {
  const recordHome = quizRecordHome();
  const older = acceptedTask(recordHome, { title: "Older", files: ["a.ts"] });
  const empty = acceptedTask(recordHome, { title: "Changed nothing", files: [] });

  assert.deepEqual(mark(recordHome, empty), []);
  assert.deepEqual(statusesOf(recordHome, older), ["live", "live", "live"]);
});

test("a delivery whose files list is not a list of strings reads as no files rather than throwing", () => {
  const recordHome = quizRecordHome();
  const older = acceptedTask(recordHome, { title: "Older", files: ["a.ts"] });
  const odd = acceptedTask(recordHome, { title: "Odd", files: ["a.ts"] });
  appendEvent(recordHome, {
    taskId: odd,
    name: "delivered",
    details: { outcome: "done", delivery: { ...fakeDelivery([]), files: "a.ts" as unknown as string[] } },
  });

  assert.deepEqual(mark(recordHome, odd), []);
  assert.deepEqual(statusesOf(recordHome, older), ["live", "live", "live"]);
});
