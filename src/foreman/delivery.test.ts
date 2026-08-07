import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDelivery, buildCommitFailureDelivery } from "./delivery.ts";
import { MAX_RECEIPT_CHECK_OUTPUT_BYTES } from "./attempts.ts";

const HEAD_MARKER = "FIRST-LINE-OF-CHECK-OUTPUT";
const TAIL_MARKER = "LAST-LINE-OF-CHECK-OUTPUT";

/** A red check that printed far more than the record may store. */
function noisyRedGate() {
  const filler = `${"x".repeat(79)}\n`.repeat(4000);
  return { green: false, output: `${HEAD_MARKER}\n${filler}${TAIL_MARKER}\n` };
}

function assertTruncatedLikeAReceipt(evidence: string) {
  assert.match(evidence, /\[truncated, showing last \d+ of \d+ bytes\]\n/);
  assert.ok(
    Buffer.byteLength(evidence, "utf8") < MAX_RECEIPT_CHECK_OUTPUT_BYTES + 400,
    `evidence was ${Buffer.byteLength(evidence, "utf8")} bytes`
  );
  assert.ok(evidence.includes(TAIL_MARKER), "the end of the output - where a check says what failed - is kept");
  assert.ok(!evidence.includes(HEAD_MARKER), "the beginning is what gets dropped");
}

test("a delivery's evidence stores only the tail of a long check output, behind a truncation marker", () => {
  const delivery = buildDelivery("failure-report", {
    taskText: "do the thing",
    attempts: 1,
    lastGate: noisyRedGate(),
    branch: "fabrica/task-1",
    files: ["a.ts"],
    declaredGateChanges: undefined,
  });

  assertTruncatedLikeAReceipt(delivery.evidence);
});

test("the discarded-protected-path evidence is truncated too, keeping its own explanation", () => {
  const delivery = buildDelivery("discarded-protected-path", {
    taskText: "do the thing",
    attempts: 1,
    lastGate: noisyRedGate(),
    branch: "fabrica/task-1",
    files: ["check.sh"],
    declaredGateChanges: undefined,
  });

  assertTruncatedLikeAReceipt(delivery.evidence);
  assert.ok(delivery.evidence.startsWith("check.sh no longer matches"));
});

test("a commit-failure delivery's evidence is truncated the same way", () => {
  const delivery = buildCommitFailureDelivery({
    attempts: 1,
    lastGate: noisyRedGate(),
    branch: "fabrica/task-1",
    declaredGateChanges: undefined,
    error: "index.lock exists",
  });

  assertTruncatedLikeAReceipt(delivery.evidence);
  assert.ok(delivery.evidence.startsWith("Last check: "));
});

test("a check output within the cap is stored in evidence exactly as it ran", () => {
  const output = "./check.sh -> exit 0\nall good\n";

  const delivery = buildDelivery("done", {
    taskText: "do the thing",
    attempts: 1,
    lastGate: { green: true, output },
    branch: "fabrica/task-1",
    files: ["a.ts"],
    declaredGateChanges: undefined,
  });

  assert.equal(delivery.evidence, output);
});
