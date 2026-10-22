// Reading GitHub's own vocabularies. The asymmetry here is deliberate
// and is the whole point of issue #267's fourth ask: an answer nobody
// understands is read as red, never as a pass.

import { test } from "node:test";
import assert from "node:assert/strict";
import { isRedConclusion, isUnresolvedCheckRunStatus, isUnresolvedCommitStatusState } from "./conclusions.ts";

test("success, neutral and skipped are not red", () => {
  for (const conclusion of ["success", "neutral", "skipped", "SUCCESS", " success "]) {
    assert.equal(isRedConclusion(conclusion), false, conclusion);
  }
});

test("every other conclusion is red, including a word this code has never seen", () => {
  for (const conclusion of ["failure", "cancelled", "timed_out", "action_required", "error", "", "something-new"]) {
    assert.equal(isRedConclusion(conclusion), true, conclusion);
  }
});

test("only a completed check run has an answer", () => {
  assert.equal(isUnresolvedCheckRunStatus("completed"), false);
  for (const status of ["queued", "in_progress", "waiting", "requested", "pending", ""]) {
    assert.equal(isUnresolvedCheckRunStatus(status), true, status);
  }
});

test("only a pending commit status has no answer", () => {
  assert.equal(isUnresolvedCommitStatusState("pending"), true);
  for (const state of ["success", "failure", "error"]) {
    assert.equal(isUnresolvedCommitStatusState(state), false, state);
  }
});
