// The record-wide readers and the one write the Client makes himself:
// marking a question right or wrong, which is the whole of what review
// mode records.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readEvents } from "../record/index.ts";

import { acceptedTask, quizRecordHome } from "./helpers/fixture.ts";
import { appendQuizRecheck } from "./events.ts";
import { QuizError } from "./errors.ts";
import { allQuizQuestions, onTaskAccepted, pendingRecheckCount, recordQuizAnswer } from "./review.ts";

test("allQuizQuestions keeps every accepted task's questions, newest acceptance first", () => {
  const recordHome = quizRecordHome();
  const older = acceptedTask(recordHome, { title: "Older", files: ["a.ts"] });
  const newer = acceptedTask(recordHome, { title: "Newer", files: ["b.ts"] });
  acceptedTask(recordHome, { title: "Unruled", files: ["c.ts"], ruling: null as unknown as string });

  const questions = allQuizQuestions(recordHome);
  assert.equal(questions.length, 6);
  assert.deepEqual([...new Set(questions.map((q) => q.taskId))], [newer, older]);
  assert.deepEqual(
    questions.slice(0, 3).map((q) => q.index),
    [0, 1, 2],
    "within a task, the order its worker wrote them in"
  );
});

test("a mark lands on the record and comes back as the question's new standing", () => {
  const recordHome = quizRecordHome();
  const id = acceptedTask(recordHome, { title: "Ship it", files: ["a.ts"] });

  const after = recordQuizAnswer(recordHome, id, 0, true);
  assert.equal(after.standing.streak, 1);
  assert.equal(after.askable, false);

  const marks = readEvents(recordHome).filter((event) => event.name === "quiz-answered");
  assert.equal(marks.length, 1);
  assert.equal(marks[0].taskId, id);
  assert.deepEqual(marks[0].details, { index: 0, right: true });
});

test("a question this record never held is refused, and nothing is appended for it", () => {
  const recordHome = quizRecordHome();
  const id = acceptedTask(recordHome, { title: "Ship it", files: ["a.ts"] });
  const before = readEvents(recordHome).length;

  assert.throws(() => recordQuizAnswer(recordHome, id, 7, true), (err: unknown) => {
    assert.ok(err instanceof QuizError);
    assert.equal(err.code, "no-such-question");
    return true;
  });
  assert.throws(() => recordQuizAnswer(recordHome, "20261022-nobody-zz", 0, true), (err: unknown) => {
    assert.ok(err instanceof QuizError);
    assert.equal(err.code, "no-such-question");
    return true;
  });
  assert.throws(() => recordQuizAnswer(recordHome, id, -1, true), (err: unknown) => {
    assert.ok(err instanceof QuizError);
    return true;
  });
  assert.equal(readEvents(recordHome).length, before, "a refused mark appends nothing");
});

test("a retired question cannot be marked - it is no longer asked at all", () => {
  const recordHome = quizRecordHome();
  const id = acceptedTask(recordHome, { title: "Ship it", files: ["a.ts"] });
  appendQuizRecheck(recordHome, id, { index: 0, outcome: "retired", note: "gone" });

  assert.throws(() => recordQuizAnswer(recordHome, id, 0, true), (err: unknown) => {
    assert.ok(err instanceof QuizError);
    assert.equal(err.code, "retired-question");
    return true;
  });
});

test("a question that went outdated while it was on screen is still marked - the mark is about the Client", () => {
  const recordHome = quizRecordHome();
  const older = acceptedTask(recordHome, { title: "Older", files: ["a.ts"] });
  const newer = acceptedTask(recordHome, { title: "Newer", files: ["a.ts"] });
  onTaskAccepted(recordHome, newer);

  const after = recordQuizAnswer(recordHome, older, 0, false);
  assert.equal(after.status, "outdated");
  assert.equal(after.standing.wrongCount, 1);
});

test("onTaskAccepted marks what the accept dates and reports how many tasks owe a re-check", () => {
  const recordHome = quizRecordHome();
  const first = acceptedTask(recordHome, { title: "First", files: ["a.ts"] });
  const second = acceptedTask(recordHome, { title: "Second", files: ["a.ts"] });
  const unrelated = acceptedTask(recordHome, { title: "Unrelated", files: ["z.ts"] });

  assert.equal(pendingRecheckCount(recordHome), 0);
  assert.deepEqual(onTaskAccepted(recordHome, unrelated), { marked: [], pending: 0 });

  const result = onTaskAccepted(recordHome, second);
  assert.deepEqual(result.marked, [first]);
  assert.equal(result.pending, 1);
  assert.equal(pendingRecheckCount(recordHome), 1);
});
