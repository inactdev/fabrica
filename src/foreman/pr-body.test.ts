import { test } from "node:test";
import assert from "node:assert/strict";
import { finalMessageFor, renderCommitMessage } from "./pr-body.ts";
import type { TranscriptEntry } from "../brain/index.ts";

function textEntry(text: string): TranscriptEntry {
  return { occurredAt: "t", kind: "text", text };
}

// Negative first: no transcript at all (a brain with nothing to say, or
// whose final message never parsed) must still produce something to
// commit - a labeled fallback, never the task's own words.
test("finalMessageFor falls back to the given label and names what's missing, never task text", () => {
  const result = finalMessageFor([], "fabrica: task-1");

  assert.equal(result.ok, false);
  assert.equal(result.title, "fabrica: task-1");
  assert.match(result.body, /missing a title line/);
});

test("finalMessageFor returns the worker's own title and rendered sections when well-formed", () => {
  const transcript = [textEntry("Add retries\n\nWhat:\na\n\nWhy:\nb\n\nHow:\nc\n\nDeviations:\nNone.")];

  const result = finalMessageFor(transcript, "fabrica: task-1");

  assert.equal(result.ok, true);
  assert.equal(result.title, "Add retries");
  assert.equal(result.body, "What:\na\n\nWhy:\nb\n\nHow:\nc\n\nDeviations:\nNone.");
});

test("renderCommitMessage joins the title and body with a blank line, matching a normal commit message shape", () => {
  const message = finalMessageFor(
    [textEntry("Add retries\n\nWhat:\na\n\nWhy:\nb\n\nHow:\nc\n\nDeviations:\nNone.")],
    "fabrica: task-1"
  );

  assert.equal(renderCommitMessage(message), "Add retries\n\nWhat:\na\n\nWhy:\nb\n\nHow:\nc\n\nDeviations:\nNone.");
});
