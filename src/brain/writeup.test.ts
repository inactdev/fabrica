// The write-up's own shared facts (contract/surface.ts's WorkerWriteup):
// the field lists both adapters build their schema from, and the quiz
// (issue #98) - the one required field with its own validator, since it
// is a list rather than a string.
//
// `writeupProblem` (src/foreman/pr-body.ts) is what the Foreman actually
// calls, and its own test covers the message a worker is told; these
// cover the two functions this file exports, including the reader every
// display surface uses to decide whether there is a quiz to show at all.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  quizEntriesOf,
  quizProblem,
  WRITEUP_FIELDS,
  WRITEUP_OPTIONAL_STRING_FIELDS,
  WRITEUP_QUIZ_LENGTH,
  WRITEUP_STRING_FIELDS,
} from "./writeup.ts";
import type { WorkerWriteup } from "./types.ts";

const QUIZ = [
  { question: "What changed?", answer: "One field on the write-up." },
  { question: "Why?", answer: "So the owner can check he understood it." },
  { question: "What should he watch?", answer: "That every delivery still carries one." },
];

const WRITEUP: WorkerWriteup = {
  title: "Add the quiz",
  why: "w",
  what: "w",
  how: "w",
  outsideChanges: "None.",
  confidence: 80,
  assumptions: "None.",
  expectedOutcomes: "o",
  deviations: "None.",
  quiz: QUIZ,
};

test("the required field list is every field of the write-up except the optional ones", () => {
  // The lists are what an adapter's schema declares `required` and what
  // it checks field by field, so a field in neither would be asked for
  // nowhere. `quiz` and `confidence` are the two non-string ones.
  assert.deepEqual(
    [...WRITEUP_FIELDS].sort(),
    [...WRITEUP_STRING_FIELDS, "confidence", "quiz"].sort()
  );
  for (const field of WRITEUP_OPTIONAL_STRING_FIELDS) {
    assert.ok(!WRITEUP_FIELDS.includes(field as never), `${field} is optional but listed as required`);
  }
});

test("quizProblem accepts exactly three answered questions, and nothing else", () => {
  assert.equal(WRITEUP_QUIZ_LENGTH, 3);
  assert.equal(quizProblem(QUIZ), undefined);

  assert.match(quizProblem(undefined) ?? "", /^the quiz is missing/);
  assert.equal(quizProblem(null), "the quiz is not a list of questions");
  assert.equal(quizProblem({ question: "q", answer: "a" }), "the quiz is not a list of questions");
  assert.equal(quizProblem([]), "the quiz has 0 questions (exactly 3 required)");
  assert.equal(quizProblem(QUIZ.slice(0, 2)), "the quiz has 2 questions (exactly 3 required)");
  assert.equal(quizProblem([...QUIZ, QUIZ[0]]), "the quiz has 4 questions (exactly 3 required)");
  assert.equal(quizProblem([QUIZ[0], "just a string", QUIZ[2]]), "quiz question 2 is not a question and answer");
  assert.equal(quizProblem([QUIZ[0], QUIZ[1], { answer: "a" }]), "quiz question 3 is empty");
  assert.equal(quizProblem([{ question: "q", answer: "   " }, QUIZ[1], QUIZ[2]]), "quiz question 1's answer is empty");
});

test("quizEntriesOf hands back a showable quiz, and an empty list when there is none", () => {
  assert.deepEqual(quizEntriesOf(WRITEUP), QUIZ);

  // Nothing to show, three ways. The middle one is the real case the
  // live view meets: a write-up recorded before this field existed. The
  // record is append-only, so it was never backfilled.
  assert.deepEqual(quizEntriesOf(undefined), []);
  assert.deepEqual(quizEntriesOf(null), []);
  assert.deepEqual(quizEntriesOf({ ...WRITEUP, quiz: undefined as unknown as WorkerWriteup["quiz"] }), []);
  assert.deepEqual(quizEntriesOf({ ...WRITEUP, quiz: QUIZ.slice(0, 2) }), []);
});
