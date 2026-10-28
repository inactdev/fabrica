import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ASK_MAX_OPTIONS,
  ASK_MIN_OPTIONS,
  askShapeProblem,
  ASK_SHAPE_NOTICE,
  deriveQuestionId,
  isOtherOption,
  OTHER_OPTION,
  QUESTION_ID_PATTERN,
  recordQuestion,
  withAskRejection,
  withOtherOption,
} from "./ask-shape.ts";

const good = { question: "Which database should this use?", options: ["Postgres", "SQLite"] };

test("askShapeProblem accepts one question with two to four options", () => {
  assert.equal(askShapeProblem({ question: good }), null);
  assert.equal(askShapeProblem({ question: { question: "Which?", options: ["a", "b", "c", "d"] } }), null);
});

test("askShapeProblem rejects a free-form list of questions, naming how many came", () => {
  assert.match(askShapeProblem({ questions: ["one?", "two?"] }) ?? "", /2 free-form questions/);
  assert.match(askShapeProblem({ questions: ["only one?"] }) ?? "", /free-form prose/);
  // Blank entries are not questions, so an all-blank list is simply
  // nothing asked rather than a shape violation to re-ask over.
  assert.match(askShapeProblem({ questions: ["  ", ""] }) ?? "", /no question was sent at all/);
});

test("askShapeProblem rejects too few and too many options, and says which", () => {
  assert.match(
    askShapeProblem({ question: { question: "Which?", options: ["only one"] } }) ?? "",
    new RegExp(`needs ${ASK_MIN_OPTIONS} to ${ASK_MAX_OPTIONS} options, got 1`)
  );
  const tooMany = askShapeProblem({ question: { question: "Which?", options: ["a", "b", "c", "d", "e"] } }) ?? "";
  assert.match(tooMany, /got 5/);
  assert.match(tooMany, /ask a narrower question/);
});

test('askShapeProblem rejects an "other" of the machine\'s own - Fabrica appends that one', () => {
  assert.match(askShapeProblem({ question: { question: "Which?", options: ["a", OTHER_OPTION] } }) ?? "", /leave "other" out/);
});

test("askShapeProblem rejects an empty question, an empty option, and two options that say the same thing", () => {
  assert.match(askShapeProblem({ question: { question: "   ", options: ["a", "b"] } }) ?? "", /question itself is empty/);
  assert.match(askShapeProblem({ question: { question: "Which?", options: ["a", " "] } }) ?? "", /every option needs actual text/);
  assert.match(askShapeProblem({ question: { question: "Which?", options: ["Same", "same "] } }) ?? "", /say the same thing/);
});

test("askShapeProblem rejects a question sent alongside free-form prose", () => {
  assert.match(askShapeProblem({ question: good, questions: ["and also?"] }) ?? "", /send the one question and its options/);
});

// Issue #175: Fabrica derives the id, so a machine can never hand two
// different questions the same one.
test("deriveQuestionId is stable across case, spacing and option order, and differs per question", () => {
  const id = deriveQuestionId(good.question, good.options);
  assert.match(id, QUESTION_ID_PATTERN);
  assert.equal(id, deriveQuestionId("  WHICH   database should this use?  ", ["SQLite", "postgres"]));
  assert.notEqual(id, deriveQuestionId(good.question, ["Postgres", "MySQL"]));
  assert.notEqual(id, deriveQuestionId("Which cache should this use?", good.options));
});

// The option Fabrica appends is on every question, so folding it into
// the hash would mean rewording its label invalidated every id ever
// derived.
test("deriveQuestionId ignores the appended 'other', so rewording that label changes no id", () => {
  assert.equal(deriveQuestionId(good.question, good.options), recordQuestion(good).id);
});

test("recordQuestion appends 'other' last, trims, and carries the derived id", () => {
  const recorded = recordQuestion({ question: " Which? ", options: [" Postgres ", "SQLite"] });
  assert.equal(recorded.question, "Which?");
  assert.deepEqual(recorded.options, ["Postgres", "SQLite", OTHER_OPTION]);
  assert.match(recorded.id, QUESTION_ID_PATTERN);
  assert.deepEqual(withOtherOption(["a"]), ["a", OTHER_OPTION]);
  assert.ok(isOtherOption(OTHER_OPTION.toUpperCase()));
  assert.equal(isOtherOption("Postgres"), false);
});

test("withAskRejection tells the machine what was wrong and restates the shape", () => {
  const reask = withAskRejection("do the thing", "a question needs 2 to 4 options, got 1");
  assert.match(reask, /^do the thing/);
  assert.match(reask, /rejected: a question needs 2 to 4 options, got 1/);
  assert.ok(reask.includes(ASK_SHAPE_NOTICE), "the re-ask carries the one shape wording every adapter uses");
});
