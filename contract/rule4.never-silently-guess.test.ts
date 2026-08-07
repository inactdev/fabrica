// CONTRACT rule 4 — It never guesses silently.
// A delivery missing confidence, assumptions, gaps, or evidence is
// malformed and must be rejected before the Client ever sees it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { validateDelivery } from "../src/index.ts";

const complete = {
  outcome: "done",
  confidence: 85,
  summary: "added the export button",
  evidence: "./check.sh -> exit 0",
  assumptions: "dates are year-month-day",
  gaps: "no tests for empty lists",
  branch: "fabrica/20260803-export-ab",
  files: ["app.txt"],
  gateChanges: "",
};

test("rule 4: a complete delivery is accepted", () => {
  assert.doesNotThrow(() => validateDelivery(complete));
});

for (const missing of ["confidence", "assumptions", "gaps", "evidence"] as const) {
  test(`rule 4: a delivery missing "${missing}" is rejected`, () => {
    const broken: Record<string, unknown> = { ...complete };
    delete broken[missing];
    assert.throws(
      () => validateDelivery(broken),
      new RegExp(missing),
      `delivery without "${missing}" was not rejected — rule 4 broken`
    );
  });
}

// The files-versus-actual-diff assertion that used to live here was
// removed by Client ruling (issue #9 follow-up): `files` is already
// computed by do.ts straight from the real diff (src/delivery's
// diffFiles), so it is ground truth handed to the Client, never a
// separate claim to weigh against it — comparing it to the diff it was
// read from compares the diff to itself and cannot fail. See
// src/delivery/README.md for the full reasoning.
