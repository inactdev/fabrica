// CONTRACT rule 4 — It never guesses silently.
// A delivery missing confidence, assumptions, gaps, or evidence is
// malformed and must be rejected before the Client ever sees it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { validateDelivery } from "./surface.ts";

const complete = {
  kind: "done",
  confidence: 85,
  did: "added the export button",
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
