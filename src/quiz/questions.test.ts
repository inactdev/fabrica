// What a question's status and schedule are derived from - the whole
// "a question must only be asked while it is still true" rule, read off
// the record and nothing else.

import { test } from "node:test";
import assert from "node:assert/strict";
import { appendEvent, readEventsForTask } from "../record/index.ts";

import { acceptedTask, quizRecordHome } from "./helpers/fixture.ts";
import { appendQuizAnswer, appendQuizRecheck, appendQuizStale } from "./events.ts";
import { acceptedAtOf, outstandingRechecks, quizQuestionsForTask } from "./questions.ts";
import { QUIZ_SESSION_GAP_MS } from "./schedule.ts";

function questionsOf(recordHome: string, taskId: string, now = Date.now()) {
  return quizQuestionsForTask(taskId, readEventsForTask(recordHome, taskId), now);
}

test("an accepted task's three questions, live and askable, each carrying its task and date", () => {
  const recordHome = quizRecordHome();
  const id = acceptedTask(recordHome, { title: "Ship it", files: ["a.ts"] });

  const questions = questionsOf(recordHome, id);
  assert.equal(questions.length, 3);
  assert.deepEqual(
    questions.map((q) => [q.index, q.status, q.askable]),
    [
      [0, "live", true],
      [1, "live", true],
      [2, "live", true],
    ]
  );
  assert.equal(questions[0].taskId, id);
  assert.equal(questions[0].taskTitle, "Ship it");
  assert.ok(questions[0].acceptedAtMs > 0);
  assert.equal(questions[0].question, "q1 of Ship it");
  assert.equal(questions[0].answer, "a1 of Ship it");
});

test("a task nobody accepted contributes no questions at all", () => {
  const recordHome = quizRecordHome();
  const delivered = acceptedTask(recordHome, { title: "Waiting", files: ["a.ts"], ruling: null as unknown as string });
  const wrong = acceptedTask(recordHome, { title: "Not it", files: ["a.ts"], ruling: "wrong" });

  assert.deepEqual(questionsOf(recordHome, delivered), []);
  assert.deepEqual(questionsOf(recordHome, wrong), []);
  assert.equal(acceptedAtOf(readEventsForTask(recordHome, wrong)), null);
});

test("a write-up with no quiz on it - the pre-quiz record, never backfilled - contributes none either", () => {
  const recordHome = quizRecordHome();
  const id = acceptedTask(recordHome, { title: "Older", files: ["a.ts"], quiz: [] });
  assert.deepEqual(questionsOf(recordHome, id), []);
});

test("a mark moves the question's schedule and takes it out of the rotation until it is due", () => {
  const recordHome = quizRecordHome();
  const id = acceptedTask(recordHome, { title: "Ship it", files: ["a.ts"] });

  appendQuizAnswer(recordHome, id, { index: 1, right: true });
  const after = questionsOf(recordHome, id);
  assert.equal(after[1].standing.streak, 1);
  assert.equal(after[1].standing.rightCount, 1);
  assert.equal(after[1].askable, false, "answered right, so not asked again today");
  assert.equal(after[0].askable, true, "its siblings are untouched");

  // And it is askable again once its due time has passed.
  const laterStill = questionsOf(recordHome, id, after[1].standing.dueAtMs + 1);
  assert.equal(laterStill[1].askable, true);
});

test("a wrong mark brings the question back after the session gap, not after a day", () => {
  const recordHome = quizRecordHome();
  const id = acceptedTask(recordHome, { title: "Ship it", files: ["a.ts"] });
  appendQuizAnswer(recordHome, id, { index: 0, right: false });

  const question = questionsOf(recordHome, id)[0];
  assert.equal(question.standing.wrongCount, 1);
  assert.equal(question.standing.dueAtMs, question.standing.lastAnsweredAtMs! + QUIZ_SESSION_GAP_MS);
});

test("a stale mark takes every one of the task's questions out of the rotation, with its reason on them", () => {
  const recordHome = quizRecordHome();
  const id = acceptedTask(recordHome, { title: "Ship it", files: ["a.ts"] });
  appendQuizStale(recordHome, id, { touchedBy: "20261022-later-task-aa", files: ["a.ts"] });

  const questions = questionsOf(recordHome, id);
  assert.deepEqual(
    questions.map((q) => [q.status, q.askable]),
    [
      ["outdated", false],
      ["outdated", false],
      ["outdated", false],
    ]
  );
  assert.deepEqual(questions[0].staleBecause, { touchedBy: "20261022-later-task-aa", files: ["a.ts"] });
});

test("a re-check confirms, rewrites, or retires - and only a confirm or a rewrite puts a question back", () => {
  const recordHome = quizRecordHome();
  const id = acceptedTask(recordHome, { title: "Ship it", files: ["a.ts"] });
  appendQuizStale(recordHome, id, { touchedBy: "20261022-later-task-aa", files: ["a.ts"] });
  appendQuizRecheck(recordHome, id, { index: 0, outcome: "confirmed", note: "still true" });
  appendQuizRecheck(recordHome, id, {
    index: 1,
    outcome: "rewritten",
    question: "What does it do now?",
    answer: "Something else.",
    note: "the answer moved",
  });
  appendQuizRecheck(recordHome, id, { index: 2, outcome: "retired", note: "that code is gone" });

  const questions = questionsOf(recordHome, id);
  assert.deepEqual(
    questions.map((q) => [q.status, q.askable]),
    [
      ["live", true],
      ["live", true],
      ["retired", false],
    ]
  );
  assert.equal(questions[0].question, "q1 of Ship it", "a confirm leaves the words alone");
  assert.equal(questions[1].question, "What does it do now?");
  assert.equal(questions[1].answer, "Something else.");
  assert.equal(questions[1].rewritten, true);
  assert.equal(questions[2].recheckNote, "that code is gone");
});

test("a rewrite resets the schedule - the marks before it were about different words", () => {
  const recordHome = quizRecordHome();
  const id = acceptedTask(recordHome, { title: "Ship it", files: ["a.ts"] });
  appendQuizAnswer(recordHome, id, { index: 0, right: true });
  appendQuizAnswer(recordHome, id, { index: 0, right: true });
  assert.equal(questionsOf(recordHome, id)[0].standing.streak, 2);

  appendQuizStale(recordHome, id, { touchedBy: "later", files: ["a.ts"] });
  appendQuizRecheck(recordHome, id, { index: 0, outcome: "rewritten", question: "New?", answer: "Yes." });

  const question = questionsOf(recordHome, id)[0];
  assert.equal(question.standing.streak, 0);
  assert.equal(question.standing.rightCount, 0);
  assert.equal(question.standing.lastAnsweredAtMs, null);
  assert.equal(question.askable, true, "a new question is due the moment it exists");
});

test("a confirm does not reset the schedule - it is the same question it always was", () => {
  const recordHome = quizRecordHome();
  const id = acceptedTask(recordHome, { title: "Ship it", files: ["a.ts"] });
  appendQuizAnswer(recordHome, id, { index: 0, right: true });
  appendQuizStale(recordHome, id, { touchedBy: "later", files: ["a.ts"] });
  appendQuizRecheck(recordHome, id, { index: 0, outcome: "confirmed" });

  assert.equal(questionsOf(recordHome, id)[0].standing.streak, 1);
});

test("a second stale mark after a re-check makes the question suspect all over again", () => {
  const recordHome = quizRecordHome();
  const id = acceptedTask(recordHome, { title: "Ship it", files: ["a.ts"] });
  appendQuizStale(recordHome, id, { touchedBy: "first", files: ["a.ts"] });
  appendQuizRecheck(recordHome, id, { index: 0, outcome: "confirmed" });
  assert.equal(questionsOf(recordHome, id)[0].status, "live");

  appendQuizStale(recordHome, id, { touchedBy: "second", files: ["a.ts"] });
  assert.equal(questionsOf(recordHome, id)[0].status, "outdated");
});

test("a retired question stays retired even if later work dates it again", () => {
  const recordHome = quizRecordHome();
  const id = acceptedTask(recordHome, { title: "Ship it", files: ["a.ts"] });
  appendQuizStale(recordHome, id, { touchedBy: "first", files: ["a.ts"] });
  appendQuizRecheck(recordHome, id, { index: 0, outcome: "retired", note: "gone" });
  appendQuizStale(recordHome, id, { touchedBy: "second", files: ["a.ts"] });

  const question = questionsOf(recordHome, id)[0];
  assert.equal(question.status, "retired");
  assert.equal(question.askable, false);
});

test("a malformed quiz event is skipped rather than throwing - this is a read of an append-only log", () => {
  const recordHome = quizRecordHome();
  const id = acceptedTask(recordHome, { title: "Ship it", files: ["a.ts"] });
  appendEvent(recordHome, { taskId: id, name: "quiz-answered", details: { index: "one", right: true } });
  appendEvent(recordHome, { taskId: id, name: "quiz-rechecked", details: { index: 0, outcome: "shrugged" } });
  appendEvent(recordHome, { taskId: id, name: "quiz-rechecked", details: { index: 0, outcome: "rewritten" } });

  const questions = questionsOf(recordHome, id);
  assert.equal(questions.length, 3);
  assert.equal(questions[0].status, "live");
  assert.equal(questions[0].question, "q1 of Ship it", "a rewrite with no replacement words changes nothing");
  assert.equal(questions[0].standing.rightCount, 0);
});

test("outstandingRechecks groups only the outdated questions, oldest acceptance first", () => {
  const recordHome = quizRecordHome();
  const older = acceptedTask(recordHome, { title: "Older", files: ["a.ts"] });
  const newer = acceptedTask(recordHome, { title: "Newer", files: ["a.ts"] });
  const untouched = acceptedTask(recordHome, { title: "Untouched", files: ["b.ts"] });
  appendQuizStale(recordHome, newer, { touchedBy: "x", files: ["a.ts"] });
  appendQuizStale(recordHome, older, { touchedBy: "x", files: ["a.ts"] });
  appendQuizRecheck(recordHome, older, { index: 0, outcome: "confirmed" });

  const now = Date.now();
  const byTask = new Map(
    [older, newer, untouched].map((id) => [id, quizQuestionsForTask(id, readEventsForTask(recordHome, id), now)])
  );
  const groups = outstandingRechecks(byTask);
  assert.deepEqual(
    groups.map((group) => [group.taskId, group.questions.map((q) => q.index)]),
    [
      [older, [1, 2]],
      [newer, [0, 1, 2]],
    ]
  );
});
