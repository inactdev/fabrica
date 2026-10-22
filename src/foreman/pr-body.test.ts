import { test } from "node:test";
import assert from "node:assert/strict";
import {
  TEMPLATE_HEADINGS,
  closesIssueFor,
  finalMessageFor,
  issueNamedByTaskText,
  renderCommitMessage,
  withClosesLine,
  writeupProblem,
} from "./pr-body.ts";
import type { WorkerWriteup } from "../brain/index.ts";

const WRITEUP: WorkerWriteup = {
  title: "Add retries",
  why: "b",
  what: "a",
  how: "c",
  outsideChanges: "None.",
  confidence: 85,
  assumptions: "d",
  expectedOutcomes: "e",
  deviations: "None.",
  quiz: [
    { question: "What changed?", answer: "The thing this test is about." },
    { question: "Why?", answer: "So the write-up is valid." },
    { question: "What should the owner watch?", answer: "Nothing - this is a test." },
  ],
};

/** The Client's template, in full, for the write-up above - the exact
 * string a reviewer sees, headings and all (Client ruling 2026-10-18). */
const BODY =
  "## Context (Why)\n\nb\n\n" +
  "## Description (What)\n\na\n\n" +
  "## Changes in the codebase (How)\n\nc\n\n" +
  "## Changes outside the codebase\n\nNone.\n\n" +
  "## Additional information\n\n" +
  "- Confidence: 85/100\n" +
  "- Assumptions: d\n" +
  "- Expected outcomes: e\n" +
  "- Deviations: None.";

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

test("writeupProblem rejects a write-up with no outsideChanges, like any other required field", () => {
  assert.equal(writeupProblem({ ...WRITEUP, outsideChanges: "" }), "the outsideChanges field is empty");
  assert.equal(writeupProblem({ ...WRITEUP, outsideChanges: "   " }), "the outsideChanges field is empty");
});

// couldNotVerify is the one optional field: leaving it out is not a
// problem, and nothing renders in its place.
test("writeupProblem accepts a write-up with no couldNotVerify at all", () => {
  assert.equal(writeupProblem({ ...WRITEUP, couldNotVerify: undefined }), undefined);
});

// The quiz (issue #98) is required, and required to be exactly three
// questions: a fourth, a missing one, or an empty answer is as much an
// invalid write-up as an empty `why`, and goes down the same red path.
// Never coerced to three (Client ruling) - this is where that is
// enforced.
test("writeupProblem rejects a quiz that isn't exactly three answered questions", () => {
  const entry = (n: number) => ({ question: `q${n}`, answer: `a${n}` });

  assert.equal(
    writeupProblem({ ...WRITEUP, quiz: undefined as unknown as WorkerWriteup["quiz"] }),
    "the quiz is missing (3 questions, each with a one-line answer)"
  );
  assert.equal(
    writeupProblem({ ...WRITEUP, quiz: "q1, q2, q3" as unknown as WorkerWriteup["quiz"] }),
    "the quiz is not a list of questions"
  );
  assert.equal(writeupProblem({ ...WRITEUP, quiz: [entry(1), entry(2)] }), "the quiz has 2 questions (exactly 3 required)");
  assert.equal(
    writeupProblem({ ...WRITEUP, quiz: [entry(1), entry(2), entry(3), entry(4)] }),
    "the quiz has 4 questions (exactly 3 required)"
  );
  assert.equal(writeupProblem({ ...WRITEUP, quiz: [entry(1)] }), "the quiz has 1 question (exactly 3 required)");
  assert.equal(
    writeupProblem({ ...WRITEUP, quiz: [entry(1), { question: "  ", answer: "a" }, entry(3)] }),
    "quiz question 2 is empty"
  );
  assert.equal(
    writeupProblem({ ...WRITEUP, quiz: [entry(1), entry(2), { question: "q3", answer: "" }] }),
    "quiz question 3's answer is empty"
  );
  // A wrapped answer is a cosmetic slip, not a reason to spend a whole
  // red round - the brief and both schemas ask for one line, nothing
  // refuses over it.
  assert.equal(writeupProblem({ ...WRITEUP, quiz: [entry(1), entry(2), { question: "q3", answer: "a\nb" }] }), undefined);
});

// Where the quiz is NOT: the pull request body is the Client's own
// four-section template (ruling 2026-10-18), and the quiz has a
// different reader - the owner, on the live view - so it is asked for,
// validated, and then deliberately left out of what Inspector opens.
test("finalMessageFor renders no quiz: it is the owner's, not the pull request's", () => {
  const message = finalMessageFor(
    { ...WRITEUP, quiz: [{ question: "Did the schema change?", answer: "Yes, one field." }, WRITEUP.quiz[1], WRITEUP.quiz[2]] },
    "fallback"
  );

  assert.equal(message.ok, true);
  assert.equal(message.body, BODY, "the body gained a section when the quiz did");
  assert.ok(!message.body.includes("Did the schema change?"));
});

test("finalMessageFor renders the Client's template exactly: five headings in order", () => {
  const result = finalMessageFor(WRITEUP, "fabrica: task-1");

  assert.equal(result.ok, true);
  assert.equal(result.title, "Add retries");
  assert.equal(result.body, BODY);
});

test("a couldNotVerify field renders as the last bullet; an empty or absent one renders no bullet at all", () => {
  const withIt = finalMessageFor({ ...WRITEUP, couldNotVerify: "Docker was not installed here." }, "x");
  assert.equal(withIt.body, `${BODY}\n- Could not verify here: Docker was not installed here.`);

  for (const value of [undefined, "", "  "]) {
    const without = finalMessageFor({ ...WRITEUP, couldNotVerify: value }, "x");
    assert.equal(without.body, BODY, `couldNotVerify ${JSON.stringify(value)} left a bullet behind`);
    assert.doesNotMatch(without.body, /Could not verify/);
  }
});

// A worker that writes more than one line into a bullet's field must not
// break out of the markdown list at the blank line between paragraphs.
test("a multi-line bullet value stays indented inside its own bullet", () => {
  const result = finalMessageFor({ ...WRITEUP, assumptions: "First one.\n\nSecond one." }, "x");

  assert.match(result.body, /^- Assumptions: First one\.\n {2}\n {2}Second one\.$/m);
});

/** How many times `heading` appears in `text`, counted as plain text so
 * an indented copy (a heading echoed inside a bullet) counts too. */
function occurrences(text: string, heading: string): number {
  return text.split(heading).length - 1;
}

// A duplicated heading was seen on a real pull request: the body read
// "## Additional information" twice in a row, with nothing between. Each
// of the template's headings is Fabrica's own to emit, exactly once -
// whatever the worker's fields hold, and wherever the body is used.
test("every template heading appears exactly once, in the body and the commit message", () => {
  const writeup = { ...WRITEUP, couldNotVerify: "The remote service was unreachable." };
  const bodies = {
    body: finalMessageFor(WRITEUP, "x").body,
    "body with couldNotVerify": finalMessageFor(writeup, "x").body,
    "body with a closing line": withClosesLine(finalMessageFor(writeup, "x").body, { number: 52 }),
    "commit message": renderCommitMessage(finalMessageFor(writeup, "x")),
  };

  assert.equal(TEMPLATE_HEADINGS.length, 5);
  for (const [what, text] of Object.entries(bodies)) {
    for (const heading of TEMPLATE_HEADINGS) {
      assert.equal(occurrences(text, heading), 1, `${what}: "${heading}" appears ${occurrences(text, heading)} times`);
    }
  }
});

// The one way a second copy of a heading can reach the body: a worker
// that echoes one into a field of its own write-up, where it lands right
// next to Fabrica's. The echo is dropped; every word around it stays.
test("a heading a worker echoed into its own field never doubles Fabrica's", () => {
  const echoed = finalMessageFor(
    {
      ...WRITEUP,
      why: "## Context (Why)\n\nb",
      outsideChanges: "None.\n\n## Additional information",
      assumptions: "d\n## Additional information",
      deviations: "## Changes in the codebase (How)\nNone.",
    },
    "x"
  );

  for (const heading of TEMPLATE_HEADINGS) {
    assert.equal(occurrences(echoed.body, heading), 1, `"${heading}" doubled`);
  }
  assert.equal(echoed.body, BODY, "the words around the echoed headings must be untouched");
});

// A write-up that quotes the template (documenting it, as this very
// change does) is showing a heading, not emitting one.
test("a heading inside a fenced code block is kept exactly as written", () => {
  const quoted = finalMessageFor({ ...WRITEUP, how: "The body is:\n\n```\n## Additional information\n```" }, "x");

  assert.match(quoted.body, /```\n## Additional information\n```/);
  assert.equal(occurrences(quoted.body, "## Additional information"), 2, "Fabrica's own, plus the quoted one");
});

test("renderCommitMessage is the title, a blank line, then the same five sections", () => {
  assert.equal(renderCommitMessage(finalMessageFor(WRITEUP, "fabrica: task-1")), `Add retries\n\n${BODY}`);
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
  assert.deepEqual(closesIssueFor("Issue #186: add retries", undefined), { number: 186 });
});

test("closesIssueFor: case 2, the caller names the issue explicitly", () => {
  assert.deepEqual(closesIssueFor("add retries, see issue 186", { number: 186 }), { number: 186 });
});

test("closesIssueFor: an explicit issue wins over what the text would have matched", () => {
  assert.deepEqual(closesIssueFor("Issue #186: add retries", { number: 194 }), { number: 194 });
});

// An issue in another repository can only ever be named explicitly
// (`fabrica do --issue owner/repo#N`): a task text's own "Issue #N:"
// prefix has no room for a repository, so it always means this one.
test("closesIssueFor: an explicitly named repository is carried through", () => {
  assert.deepEqual(closesIssueFor("do the inspector side", { number: 45, repo: "inactdev/inspector" }), {
    number: 45,
    repo: "inactdev/inspector",
  });
});

test("closesIssueFor: a task that is only part of an issue's work gets neither", () => {
  assert.equal(closesIssueFor("the first half of #186, only the worker part", undefined), undefined);
});

// The Client's template puts it first, not last (ruling 2026-10-18).
test("withClosesLine makes \"Closes #N\" the body's very first line, only when an issue is set", () => {
  assert.equal(withClosesLine(BODY, { number: 186 }), `Closes #186\n\n${BODY}`);
  assert.equal(withClosesLine(BODY, undefined), BODY);
});

// GitHub's own documented spelling for a closing keyword across
// repositories ("Linking a pull request to an issue": KEYWORD
// OWNER/REPOSITORY#ISSUE-NUMBER). A bare "Closes #45" in a pull request
// on another repository would close whatever issue happens to carry that
// number there.
test("withClosesLine names an issue in another repository in full", () => {
  assert.equal(
    withClosesLine(BODY, { number: 45, repo: "inactdev/inspector" }),
    `Closes inactdev/inspector#45\n\n${BODY}`
  );
});
