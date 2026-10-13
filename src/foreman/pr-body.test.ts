import { test } from "node:test";
import assert from "node:assert/strict";
import { finalMessageFor, renderCommitMessage, writeupProblem } from "./pr-body.ts";
import type { WorkerWriteup } from "../brain/index.ts";

const WRITEUP: WorkerWriteup = { title: "Add retries", what: "a", why: "b", how: "c", deviations: "None." };

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

test("finalMessageFor returns the worker's own title and rendered sections when valid", () => {
  const result = finalMessageFor(WRITEUP, "fabrica: task-1");

  assert.equal(result.ok, true);
  assert.equal(result.title, "Add retries");
  assert.equal(result.body, "What:\na\n\nWhy:\nb\n\nHow:\nc\n\nDeviations:\nNone.");
});

test("renderCommitMessage is the title, a blank line, then the body", () => {
  assert.equal(
    renderCommitMessage(finalMessageFor(WRITEUP, "fabrica: task-1")),
    "Add retries\n\nWhat:\na\n\nWhy:\nb\n\nHow:\nc\n\nDeviations:\nNone."
  );
});
