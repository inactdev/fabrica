// Every brief tells a worker two things beyond rule 11's standing
// question itself: where a durable project note belongs (notes/, one
// file per task, never appended straight into the project's root
// agent-memory file's shared body - the merge-conflict fix that file
// documents), and that a fix has to name the code's other instances of
// the same shape. Both are put there the same way the standing question
// is: by Fabrica's own code, not left to a file the model might or might
// not read.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DURABLE_NOTES_NOTICE,
  ONLY_TOUCHED_TESTS_NOTICE,
  SAME_SHAPE_NOTICE,
  withStandingQuestion,
} from "./standing-question.ts";

test("withStandingQuestion includes the durable-notes notice exactly once", () => {
  const brief = withStandingQuestion("do the thing");
  assert.ok(brief.includes(DURABLE_NOTES_NOTICE));
  assert.equal(brief.split(DURABLE_NOTES_NOTICE).length - 1, 1);
  assert.ok(brief.endsWith("do the thing"));
});

test("withStandingQuestion includes the same-shape notice exactly once", () => {
  const brief = withStandingQuestion("do the thing");
  assert.ok(brief.includes(SAME_SHAPE_NOTICE), "a brief does not ask the worker to list the code's other instances of the same shape");
  assert.equal(brief.split(SAME_SHAPE_NOTICE).length - 1, 1);
});

test("withStandingQuestion is idempotent - re-applying never doubles the notice", () => {
  const once = withStandingQuestion("do the thing");
  const twice = withStandingQuestion(once);
  assert.equal(twice, once);
  assert.equal(twice.split(DURABLE_NOTES_NOTICE).length - 1, 1);
  assert.equal(twice.split(SAME_SHAPE_NOTICE).length - 1, 1);
});

// Issue #142: unlike the four fixed notices, this one is conditional -
// the project's own settings decide it (src/foreman/touched-tests.ts).
test("withStandingQuestion carries the only-touched-tests notice only when asked", () => {
  const off = withStandingQuestion("do the thing");
  assert.ok(!off.includes(ONLY_TOUCHED_TESTS_NOTICE));

  const on = withStandingQuestion("do the thing", { onlyTouchedTests: true });
  assert.ok(on.includes(ONLY_TOUCHED_TESTS_NOTICE));
  assert.equal(on.split(ONLY_TOUCHED_TESTS_NOTICE).length - 1, 1);
  assert.ok(on.endsWith("do the thing"), "the task's own words still come last");
  assert.ok(on.startsWith(off.slice(0, off.indexOf("do the thing"))), "rule 11's prefix still comes first, unchanged");
});

// The guard keys on the fixed prefix, which the conditional notice sits
// after - so a nested re-application can neither double rule 11's
// prefix nor quietly drop a notice the outer builder already resolved.
test("withStandingQuestion: a brief an outer builder already prefixed comes back untouched", () => {
  const prefixed = withStandingQuestion("do the thing", { onlyTouchedTests: true });
  assert.equal(withStandingQuestion(prefixed), prefixed, "a re-application dropped the notice");
  assert.equal(withStandingQuestion(prefixed, { onlyTouchedTests: true }), prefixed);

  const plain = withStandingQuestion("do the thing");
  assert.equal(withStandingQuestion(plain, { onlyTouchedTests: true }), plain, "a re-application added one");
});
