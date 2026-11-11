// Reading GitHub's own vocabularies. The asymmetry here is deliberate
// and is the whole point of issue #267's fourth ask: an answer nobody
// understands is read as red, never as a pass.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isNoResultConclusion,
  isRedConclusion,
  isUnresolvedCheckRunStatus,
  isUnresolvedCommitStatusState,
} from "./conclusions.ts";

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

test("only cancelled is no result at all - and it is still red to a caller that did not filter it", () => {
  for (const conclusion of ["cancelled", "CANCELLED", " cancelled "]) {
    assert.equal(isNoResultConclusion(conclusion), true, conclusion);
  }
  for (const conclusion of ["success", "failure", "neutral", "skipped", "timed_out", "", "something-new"]) {
    assert.equal(isNoResultConclusion(conclusion), false, conclusion);
  }
  // `latest.ts` drops a cancelled run before anything asks this, so the
  // two answers never disagree in practice - and an unfiltered caller
  // errs red rather than green, which is the safe direction.
  assert.equal(isRedConclusion("cancelled"), true);
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
