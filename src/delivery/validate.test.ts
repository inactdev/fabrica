import { test } from "node:test";
import assert from "node:assert/strict";
import { validateDelivery } from "./validate.ts";
import { DeliveryError } from "./errors.ts";

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

test("a complete delivery is accepted", () => {
  assert.doesNotThrow(() => validateDelivery(complete));
});

test("an empty gateChanges/gaps/assumptions is not treated as missing", () => {
  assert.doesNotThrow(() => validateDelivery({ ...complete, gateChanges: "", gaps: "", assumptions: "" }));
});

test("an empty files array is not treated as missing", () => {
  assert.doesNotThrow(() => validateDelivery({ ...complete, files: [] }));
});

for (const field of [
  "outcome",
  "confidence",
  "summary",
  "evidence",
  "assumptions",
  "gaps",
  "branch",
  "files",
  "gateChanges",
] as const) {
  test(`a delivery missing "${field}" is rejected`, () => {
    const broken: Record<string, unknown> = { ...complete };
    delete broken[field];
    assert.throws(
      () => validateDelivery(broken),
      (err: unknown) => err instanceof DeliveryError && err.code === "malformed" && new RegExp(field).test(err.message)
    );
  });
}

test("an invalid outcome is rejected", () => {
  assert.throws(() => validateDelivery({ ...complete, outcome: "sort-of-done" }), /outcome/);
});

test("a non-numeric confidence is rejected", () => {
  assert.throws(() => validateDelivery({ ...complete, confidence: "85" }), /confidence/);
});

test("a files array with a non-string entry is rejected", () => {
  assert.throws(() => validateDelivery({ ...complete, files: ["app.txt", 42] }), /files/);
});

test("a non-object delivery is rejected", () => {
  assert.throws(() => validateDelivery(null));
  assert.throws(() => validateDelivery("not a delivery"));
});
