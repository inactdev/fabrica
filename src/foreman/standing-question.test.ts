// Every brief tells a worker where a durable project note belongs
// (notes/, one file per task) instead of appending straight into the
// project's root agent-memory file's shared body - the merge-conflict
// fix this file documents, applied the same way rule 11's standing
// question is: by Fabrica's own code, not left to a file the model
// might or might not read.

import { test } from "node:test";
import assert from "node:assert/strict";
import { DURABLE_NOTES_NOTICE, withStandingQuestion } from "./standing-question.ts";

test("withStandingQuestion includes the durable-notes notice exactly once", () => {
  const brief = withStandingQuestion("do the thing");
  assert.ok(brief.includes(DURABLE_NOTES_NOTICE));
  assert.equal(brief.split(DURABLE_NOTES_NOTICE).length - 1, 1);
  assert.ok(brief.endsWith("do the thing"));
});

test("withStandingQuestion is idempotent - re-applying never doubles the notice", () => {
  const once = withStandingQuestion("do the thing");
  const twice = withStandingQuestion(once);
  assert.equal(twice, once);
  assert.equal(twice.split(DURABLE_NOTES_NOTICE).length - 1, 1);
});
