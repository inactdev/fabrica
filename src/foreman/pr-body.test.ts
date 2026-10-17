import { test } from "node:test";
import assert from "node:assert/strict";
import { closesIssueFor, finalMessageFor, issueNamedByTaskText, renderCommitMessage, withClosesLine, writeupProblem } from "./pr-body.ts";
import type { WorkerWriteup } from "../brain/index.ts";

const WRITEUP: WorkerWriteup = {
  title: "Add retries",
  what: "a",
  why: "b",
  how: "c",
  confidence: 85,
  assumptions: "d",
  expectedOutcomes: "e",
  deviations: "None.",
};

// Negative first: no write-up at all (a brain that returned none) must
// still produce something to commit - a labeled fallback, never the
// task's own words.
test("finalMessageFor falls back to the given label and names what's wrong, never task text", () => {
  const result = finalMessageFor(undefined, "fabrica: task-1");

  assert.equal(result.ok, false);
  assert.equal(result.title, "fabrica: task-1");
  assert.equal(result.body, "write-up invalid: the worker returned no write-up.");
  assert.equal(result.reason, "the worker returned no write-up");
});

test("writeupProblem names every empty field and an over-long title, together", () => {
  assert.equal(
    writeupProblem({ ...WRITEUP, title: "y".repeat(61), why: " ", deviations: "" }),
    "the why field is empty; the deviations field is empty; the title is 61 characters (at most 60)"
  );
  assert.equal(writeupProblem(WRITEUP), undefined);
});

test("writeupProblem rejects a confidence outside 0-100, or not a number", () => {
  assert.equal(
    writeupProblem({ ...WRITEUP, confidence: 101 }),
    "the confidence field is not a number from 0 to 100"
  );
  assert.equal(
    writeupProblem({ ...WRITEUP, confidence: -1 }),
    "the confidence field is not a number from 0 to 100"
  );
  assert.equal(
    writeupProblem({ ...WRITEUP, confidence: Number.NaN }),
    "the confidence field is not a number from 0 to 100"
  );
});

test("finalMessageFor returns the worker's own title and rendered sections when valid", () => {
  const result = finalMessageFor(WRITEUP, "fabrica: task-1");

  assert.equal(result.ok, true);
  assert.equal(result.title, "Add retries");
  assert.equal(
    result.body,
    "What:\na\n\nWhy:\nb\n\nHow:\nc\n\n" +
      "What to look at:\nConfidence: 85/100\n\nAssumptions:\nd\n\nExpected outcomes:\ne\n\nDeviations:\nNone."
  );
});

test("renderCommitMessage is the title, a blank line, then the body", () => {
  assert.equal(
    renderCommitMessage(finalMessageFor(WRITEUP, "fabrica: task-1")),
    "Add retries\n\nWhat:\na\n\nWhy:\nb\n\nHow:\nc\n\n" +
      "What to look at:\nConfidence: 85/100\n\nAssumptions:\nd\n\nExpected outcomes:\ne\n\nDeviations:\nNone."
  );
});

// "make every pull request it opens close its issue on merge": a task
// whose own text names exactly one issue as the whole of the work (case
// 1) or whose caller names it explicitly (case 2) gets a closing line;
// a task that is only part of an issue's work (e.g. "the first half of
// #186") gets neither.

test("issueNamedByTaskText matches only an \"Issue #N:\" prefix at the very start", () => {
  assert.equal(issueNamedByTaskText("Issue #186: add retries"), 186);
  assert.equal(issueNamedByTaskText("issue #186: add retries"), undefined, "wrong case does not match");
  assert.equal(issueNamedByTaskText("the first half of #186, only the worker part"), undefined);
  assert.equal(issueNamedByTaskText("fabrica issues 185 and 194 together"), undefined);
  assert.equal(issueNamedByTaskText("Please see Issue #186: add retries"), undefined, "must be at the very start");
});

test("closesIssueFor: case 1, the task's own text names the issue", () => {
  assert.equal(closesIssueFor("Issue #186: add retries", undefined), 186);
});

test("closesIssueFor: case 2, the caller names the issue explicitly", () => {
  assert.equal(closesIssueFor("add retries, see issue 186", 186), 186);
});

test("closesIssueFor: an explicit issue wins over what the text would have matched", () => {
  assert.equal(closesIssueFor("Issue #186: add retries", 194), 194);
});

test("closesIssueFor: a task that is only part of an issue's work gets neither", () => {
  assert.equal(closesIssueFor("the first half of #186, only the worker part", undefined), undefined);
});

test("withClosesLine appends \"Closes #N\" only when an issue is set", () => {
  assert.equal(withClosesLine("What:\na", 186), "What:\na\n\nCloses #186");
  assert.equal(withClosesLine("What:\na", undefined), "What:\na");
});
